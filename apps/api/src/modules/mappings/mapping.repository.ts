import type { Types } from 'mongoose';

import {
  MappingDecisionModel,
  MappingSuggestionModel,
  type MappingDecisionDoc,
  type MappingSuggestionDoc,
} from './mapping.model.js';
import type {
  MappingDecision,
  MappingRepository,
  MappingSuggestion,
  StoredSuggestion,
} from './mapping.types.js';

type StoredSuggestionDoc = MappingSuggestionDoc & { jobId: Types.ObjectId };
type StoredDecisionDoc = MappingDecisionDoc & { decidedBy: Types.ObjectId };

export function toStoredSuggestion(doc: StoredSuggestionDoc): StoredSuggestion {
  return {
    column: doc.column,
    position: doc.position,
    // Shape owned by the worker's Pydantic Suggestion model (camelCase aliases).
    suggestion: doc.suggestion as MappingSuggestion,
    run: {
      jobId: doc.jobId.toHexString(),
      runId: doc.runId,
      schemaVersion: doc.schemaVersion,
      method: doc.method,
      model: doc.model ?? null,
      createdAt: doc.createdAt,
    },
  };
}

function toDecision(doc: StoredDecisionDoc): MappingDecision {
  return {
    column: doc.column,
    decision: doc.decision,
    target: doc.target ?? null,
    role: doc.role,
    transform: doc.transform ?? null,
    schemaVersion: doc.schemaVersion,
    decidedBy: doc.decidedBy.toHexString(),
    decidedAt: doc.decidedAt,
  };
}

export function createMongoMappingRepository(): MappingRepository {
  return {
    async listSuggestions(projectId, sourceId) {
      const docs = await MappingSuggestionModel.find({ projectId, sourceId })
        .sort({ position: 1 })
        .lean<StoredSuggestionDoc[]>();
      return docs.map(toStoredSuggestion);
    },
    async listDecisions(projectId, sourceId) {
      const docs = await MappingDecisionModel.find({ projectId, sourceId }).lean<
        StoredDecisionDoc[]
      >();
      return docs.map(toDecision);
    },
    async saveDecision(projectId, sourceId, decision) {
      await MappingDecisionModel.replaceOne(
        { projectId, sourceId, column: decision.column },
        { projectId, sourceId, ...decision },
        { upsert: true, runValidators: true },
      );
    },
    async deleteBySource(projectId, sourceId) {
      await MappingSuggestionModel.deleteMany({ projectId, sourceId });
      await MappingDecisionModel.deleteMany({ projectId, sourceId });
    },
    async deleteByProject(projectId) {
      await MappingSuggestionModel.deleteMany({ projectId });
      await MappingDecisionModel.deleteMany({ projectId });
    },
  };
}
