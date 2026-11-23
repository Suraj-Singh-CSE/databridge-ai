import { Types } from 'mongoose';

import { KnowledgeSummaryModel } from './knowledge.model.js';
import {
  CHUNK_KINDS,
  type ChunkKind,
  type KnowledgeRepository,
  type KnowledgeSummary,
} from './knowledge.types.js';

/** What the worker stores (apps/ai-service handlers/knowledge.py). */
interface StoredSummary {
  projectId: Types.ObjectId;
  jobId: Types.ObjectId;
  chunkCount?: number;
  chunksByKind?: Partial<Record<ChunkKind, number>>;
  droppedByPrivacyGuard?: number;
  maskedDocs?: number;
  mode?: KnowledgeSummary['mode'];
  embeddingModel?: string | null;
  embedded?: number;
  reused?: number;
  embeddingError?: string | null;
  finishedAt: Date;
}

export function toKnowledgeSummary(doc: StoredSummary): KnowledgeSummary {
  const byKind = doc.chunksByKind ?? {};
  return {
    projectId: doc.projectId.toHexString(),
    jobId: doc.jobId.toHexString(),
    chunkCount: doc.chunkCount ?? 0,
    chunksByKind: Object.fromEntries(
      CHUNK_KINDS.map((kind) => [kind, byKind[kind] ?? 0]),
    ) as Record<ChunkKind, number>,
    droppedByPrivacyGuard: doc.droppedByPrivacyGuard ?? 0,
    maskedDocs: doc.maskedDocs ?? 0,
    mode: doc.mode ?? 'keyword',
    embeddingModel: doc.embeddingModel ?? null,
    embedded: doc.embedded ?? 0,
    reused: doc.reused ?? 0,
    embeddingError: doc.embeddingError ?? null,
    finishedAt: doc.finishedAt,
  };
}

export function createMongoKnowledgeRepository(): KnowledgeRepository {
  return {
    async findSummary(projectId) {
      const doc = await KnowledgeSummaryModel.findOne({
        projectId: new Types.ObjectId(projectId),
      }).lean<StoredSummary>();
      return doc ? toKnowledgeSummary(doc) : null;
    },
  };
}
