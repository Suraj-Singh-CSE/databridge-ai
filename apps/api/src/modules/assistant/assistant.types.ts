import type { AssistantCitation, AssistantRefusalReason } from '../../ai-service.client.js';

/**
 * One question and its answer (ADR 0025). `question` is null when the question guard refused
 * it for holding personal data: such a question is never stored, only its reason code.
 */
export interface AssistantTurn {
  question: string | null;
  answer: string;
  citations: AssistantCitation[];
  confidence: 'high' | 'medium' | 'low';
  answerable: boolean;
  refusalReason: AssistantRefusalReason | null;
  mode: 'hybrid' | 'keyword' | null;
  model: string | null;
  latencyMs: number;
  createdAt: Date;
}

export interface AssistantConversation {
  id: string;
  projectId: string;
  userId: string;
  /** The first stored question (shortened), or a fixed title. */
  title: string;
  turns: AssistantTurn[];
  createdAt: Date;
  updatedAt: Date;
}

export type ConversationSummary = Omit<AssistantConversation, 'turns'> & { turnCount: number };

export interface AssistantUsageCounts {
  conversations: number;
  users: number;
  questions: number;
  answered: number;
  refusals: Record<AssistantRefusalReason, number>;
  /** Mean of the stored turns' latency, null without turns. */
  avgLatencyMs: number | null;
}

export interface AssistantRepository {
  create(input: {
    projectId: string;
    userId: string;
    title: string;
  }): Promise<AssistantConversation>;
  findById(projectId: string, conversationId: string): Promise<AssistantConversation | null>;
  /** Appends a turn, keeping only the newest `maxTurns`. */
  appendTurn(conversationId: string, turn: AssistantTurn, maxTurns: number): Promise<void>;
  listByUser(projectId: string, userId: string, limit: number): Promise<ConversationSummary[]>;
  delete(projectId: string, conversationId: string): Promise<boolean>;
  deleteByProject(projectId: string): Promise<void>;
  usage(projectId: string): Promise<AssistantUsageCounts>;
}

export const REFUSAL_REASONS: readonly AssistantRefusalReason[] = [
  'personal_data',
  'weak_retrieval',
  'not_answerable',
  'no_citation',
  'daily_budget',
];
