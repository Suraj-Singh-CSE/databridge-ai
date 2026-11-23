import { Types } from 'mongoose';

import { AssistantConversationModel } from './assistant.model.js';
import {
  REFUSAL_REASONS,
  type AssistantConversation,
  type AssistantRepository,
  type AssistantTurn,
  type ConversationSummary,
} from './assistant.types.js';

const oid = (id: string) => new Types.ObjectId(id);

interface StoredConversation {
  _id: Types.ObjectId;
  projectId: Types.ObjectId;
  userId: Types.ObjectId;
  title: string;
  turns?: AssistantTurn[];
  turnCount?: number;
  createdAt: Date;
  updatedAt: Date;
}

function toSummary(doc: StoredConversation): ConversationSummary {
  return {
    id: doc._id.toHexString(),
    projectId: doc.projectId.toHexString(),
    userId: doc.userId.toHexString(),
    title: doc.title,
    turnCount: doc.turnCount ?? doc.turns?.length ?? 0,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function toConversation(doc: StoredConversation): AssistantConversation {
  const { turnCount: _count, ...summary } = toSummary(doc);
  return {
    ...summary,
    turns: (doc.turns ?? []).map((turn) => ({
      question: turn.question ?? null,
      answer: turn.answer,
      citations: turn.citations.map((c) => ({
        n: c.n,
        chunkId: c.chunkId,
        kind: c.kind,
        title: c.title,
        link: { page: c.link.page, params: c.link.params },
      })),
      confidence: turn.confidence,
      answerable: turn.answerable,
      refusalReason: turn.refusalReason ?? null,
      mode: turn.mode ?? null,
      model: turn.model ?? null,
      latencyMs: turn.latencyMs,
      createdAt: turn.createdAt,
    })),
  };
}

interface UsageFacet {
  conversations: { count: number; users: Types.ObjectId[] }[];
  turns: { _id: string | null; count: number; latency: number }[];
}

export function createMongoAssistantRepository(): AssistantRepository {
  return {
    async create({ projectId, userId, title }) {
      const doc = await AssistantConversationModel.create({
        projectId: oid(projectId),
        userId: oid(userId),
        title,
        turns: [],
      });
      return toConversation(doc.toObject() as StoredConversation);
    },
    async findById(projectId, conversationId) {
      const doc = await AssistantConversationModel.findOne({
        _id: oid(conversationId),
        projectId: oid(projectId),
      }).lean<StoredConversation>();
      return doc ? toConversation(doc) : null;
    },
    async appendTurn(conversationId, turn, maxTurns) {
      await AssistantConversationModel.updateOne(
        { _id: oid(conversationId) },
        { $push: { turns: { $each: [turn], $slice: -maxTurns } } },
      );
    },
    async listByUser(projectId, userId, limit) {
      const docs = await AssistantConversationModel.aggregate<StoredConversation>([
        { $match: { projectId: oid(projectId), userId: oid(userId) } },
        { $sort: { updatedAt: -1, _id: -1 } },
        { $limit: limit },
        {
          $project: {
            projectId: 1,
            userId: 1,
            title: 1,
            createdAt: 1,
            updatedAt: 1,
            turnCount: { $size: '$turns' },
          },
        },
      ]);
      return docs.map(toSummary);
    },
    async delete(projectId, conversationId) {
      const result = await AssistantConversationModel.deleteOne({
        _id: oid(conversationId),
        projectId: oid(projectId),
      });
      return result.deletedCount > 0;
    },
    async deleteByProject(projectId) {
      await AssistantConversationModel.deleteMany({ projectId: oid(projectId) });
    },
    async usage(projectId) {
      const [facet] = await AssistantConversationModel.aggregate<UsageFacet>([
        { $match: { projectId: oid(projectId) } },
        {
          $facet: {
            conversations: [
              { $group: { _id: null, count: { $sum: 1 }, users: { $addToSet: '$userId' } } },
            ],
            turns: [
              { $unwind: '$turns' },
              {
                $group: {
                  _id: '$turns.refusalReason',
                  count: { $sum: 1 },
                  latency: { $sum: '$turns.latencyMs' },
                },
              },
            ],
          },
        },
      ]);
      const groups = facet?.turns ?? [];
      const questions = groups.reduce((sum, g) => sum + g.count, 0);
      const latency = groups.reduce((sum, g) => sum + g.latency, 0);
      const count = (reason: string | null) => groups.find((g) => g._id === reason)?.count ?? 0;
      const conversations = facet?.conversations[0];
      return {
        conversations: conversations?.count ?? 0,
        users: conversations?.users.length ?? 0,
        questions,
        answered: count(null),
        refusals: Object.fromEntries(REFUSAL_REASONS.map((r) => [r, count(r)])) as Record<
          (typeof REFUSAL_REASONS)[number],
          number
        >,
        avgLatencyMs: questions ? Math.round(latency / questions) : null,
      };
    },
  };
}
