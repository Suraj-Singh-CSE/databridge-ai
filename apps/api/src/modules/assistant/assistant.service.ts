import { AiServiceError, type AiServiceClient } from '../../ai-service.client.js';
import { AppError } from '../../errors.js';
import type { Logger } from '../../logger.js';
import type { AuditService } from '../audit/audit.service.js';
import type { DashboardRepository } from '../dashboard/dashboard.types.js';
import type { KnowledgeRepository } from '../knowledge/knowledge.types.js';
import type { Actor } from '../projects/project.service.js';
import type { Project } from '../projects/project.types.js';

import type {
  AssistantConversation,
  AssistantRepository,
  AssistantTurn,
  AssistantUsageCounts,
  ConversationSummary,
} from './assistant.types.js';
import type { QuestionLimiter } from './rate-limit.js';

export const KNOWLEDGE_NOT_BUILT_MESSAGE = 'Build the project knowledge index first.';
export const ASSISTANT_UNAVAILABLE_MESSAGE =
  'The assistant is not available right now. Please try again in a minute.';
const TITLE_CHARS = 80;
const REFUSED_TITLE = 'Conversation';
// Turns sent to the ai-service as history (it keeps its own, smaller, number).
const HISTORY_SENT = 10;

export interface AssistantUsage extends AssistantUsageCounts {
  model: {
    calls: number;
    ok: number;
    inputTokens: number;
    outputTokens: number;
    costInr: number;
    models: string[];
  };
}

export interface AssistantService {
  ask(
    actor: Actor,
    project: Project,
    input: { question: string; conversationId?: string | undefined },
  ): Promise<{ conversationId: string; turn: AssistantTurn }>;
  list(actor: Actor, project: Project, limit: number): Promise<ConversationSummary[]>;
  get(actor: Actor, project: Project, conversationId: string): Promise<AssistantConversation>;
  remove(actor: Actor, project: Project, conversationId: string): Promise<void>;
  usage(project: Project): Promise<AssistantUsage>;
}

interface Deps {
  conversations: AssistantRepository;
  knowledge: KnowledgeRepository;
  dashboard: DashboardRepository;
  aiService: AiServiceClient;
  audit: AuditService;
  limiter: QuestionLimiter;
  logger: Logger;
  maxTurns: number;
}

function title(question: string | null): string {
  if (!question) return REFUSED_TITLE;
  return question.length > TITLE_CHARS ? `${question.slice(0, TITLE_CHARS - 1)}…` : question;
}

export function createAssistantService({
  conversations,
  knowledge,
  dashboard,
  aiService,
  audit,
  limiter,
  logger,
  maxTurns,
}: Deps): AssistantService {
  /** The caller's own conversation; anyone else's (or a missing one) is 404. */
  async function own(actor: Actor, project: Project, id: string): Promise<AssistantConversation> {
    const found = await conversations.findById(project.id, id);
    if (found?.userId === actor.user.userId) return found;
    throw AppError.notFound('Conversation not found.');
  }

  return {
    async ask(actor, project, { question, conversationId }) {
      if (!limiter.take(actor.user.userId)) {
        throw new AppError(429, 'RATE_LIMITED', 'Too many questions. Please wait a minute.');
      }
      const existing = conversationId ? await own(actor, project, conversationId) : null;
      if (!(await knowledge.findSummary(project.id))) {
        throw new AppError(409, 'KNOWLEDGE_NOT_BUILT', KNOWLEDGE_NOT_BUILT_MESSAGE);
      }
      const history = (existing?.turns ?? [])
        .filter((t): t is AssistantTurn & { question: string } => t.question !== null)
        .filter((t) => t.answerable)
        .slice(-HISTORY_SENT)
        .map((t) => ({ question: t.question, answer: t.answer }));
      let reply;
      try {
        reply = await aiService.askAssistant(
          { projectId: project.id, question, history },
          actor.requestId,
        );
      } catch (error) {
        if (error instanceof AiServiceError && error.code === 'KNOWLEDGE_NOT_BUILT') {
          throw new AppError(409, 'KNOWLEDGE_NOT_BUILT', KNOWLEDGE_NOT_BUILT_MESSAGE);
        }
        logger.warn(
          {
            requestId: actor.requestId,
            status: error instanceof AiServiceError ? error.status : null,
            code: error instanceof AiServiceError ? error.code : null,
          },
          'assistant unavailable',
        );
        throw new AppError(503, 'AI_SERVICE_UNAVAILABLE', ASSISTANT_UNAVAILABLE_MESSAGE);
      }
      // A question the guard refused for personal data is never stored: only its reason code.
      const stored = reply.refusalReason === 'personal_data' ? null : question;
      const turn: AssistantTurn = {
        question: stored,
        answer: reply.answer,
        citations: reply.citations,
        confidence: reply.confidence,
        answerable: reply.answerable,
        refusalReason: reply.refusalReason,
        mode: reply.mode,
        model: reply.model,
        latencyMs: reply.latencyMs,
        createdAt: new Date(),
      };
      const conversation =
        existing ??
        (await conversations.create({
          projectId: project.id,
          userId: actor.user.userId,
          title: title(stored),
        }));
      await conversations.appendTurn(conversation.id, turn, maxTurns);
      logger.info(
        {
          requestId: actor.requestId,
          answerable: reply.answerable,
          refusalReason: reply.refusalReason,
          citations: reply.citations.length,
          latencyMs: reply.latencyMs,
        },
        'assistant answered',
      );
      return { conversationId: conversation.id, turn };
    },

    async list(actor, project, limit) {
      return conversations.listByUser(project.id, actor.user.userId, limit);
    },

    async get(actor, project, conversationId) {
      return own(actor, project, conversationId);
    },

    async remove(actor, project, conversationId) {
      const found = await own(actor, project, conversationId);
      await conversations.delete(project.id, conversationId);
      await audit.record({
        projectId: project.id,
        actorId: actor.user.userId,
        action: 'assistant_conversation.delete',
        entityType: 'assistant_conversation',
        entityId: conversationId,
        before: { turnCount: found.turns.length },
        requestId: actor.requestId,
      });
    },

    async usage(project) {
      const counts = await conversations.usage(project.id);
      const stats = await dashboard.llmStats(project.id, new Date(0));
      const task = stats.tasks.find((t) => t.task === 'assistant');
      return {
        ...counts,
        model: {
          calls: task?.calls ?? 0,
          ok: task?.ok ?? 0,
          inputTokens: task?.inputTokens ?? 0,
          outputTokens: task?.outputTokens ?? 0,
          costInr: task?.costInr ?? 0,
          models: task?.models ?? [],
        },
      };
    },
  };
}
