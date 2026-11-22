import { StagedRecordModel, type StagedRecordDoc } from './staged.model.js';
import type { StagedRecord, StagedRecordRepository } from './staged.types.js';

export function toStagedRecord(doc: StagedRecordDoc): StagedRecord {
  return {
    rowNumber: doc.rowNumber,
    sourceRecordId: doc.sourceRecordId ?? null,
    // Shape owned by the worker: target field -> string or null.
    fields: doc.fields as Record<string, string | null>,
    issues: doc.issues.map(({ field, code }) => ({ field, code })),
  };
}

export function createMongoStagedRecordRepository(): StagedRecordRepository {
  return {
    async list(projectId, sourceId, { runId, afterRow, limit, issuesOnly }) {
      const docs = await StagedRecordModel.find({
        projectId,
        sourceId,
        runId,
        rowNumber: { $gt: afterRow },
        ...(issuesOnly ? { hasIssues: true } : {}),
      })
        .sort({ rowNumber: 1 })
        .limit(limit)
        .lean<StagedRecordDoc[]>();
      return docs.map(toStagedRecord);
    },
    async deleteBySource(projectId, sourceId) {
      await StagedRecordModel.deleteMany({ projectId, sourceId });
    },
    async deleteByProject(projectId) {
      await StagedRecordModel.deleteMany({ projectId });
    },
  };
}
