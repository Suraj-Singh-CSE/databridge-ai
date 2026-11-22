import {
  CandidatePairModel,
  CandidateSummaryModel,
  type CandidatePairDoc,
  type CandidateSummaryDoc,
} from './candidate.model.js';
import type { CandidateRepository, CandidateSummary, KeyCount } from './candidate.types.js';

const counts = (list: readonly KeyCount[]): KeyCount[] =>
  list.map(({ key, count }) => ({ key, count }));

export function toCandidateSummary(doc: CandidateSummaryDoc): CandidateSummary {
  return {
    jobId: doc.jobId.toHexString(),
    runId: doc.runId,
    sources: doc.sources.map(({ sourceId, runId, rowCount }) => ({ sourceId, runId, rowCount })),
    recordCount: doc.recordCount,
    possiblePairs: doc.possiblePairs,
    pairCount: doc.pairCount,
    reductionRatio: doc.reductionRatio,
    pairsByKey: counts(doc.pairsByKey),
    pairsOnlyByKey: counts(doc.pairsOnlyByKey),
    oversizeBlocksSkipped: doc.oversizeBlocksSkipped,
    oversizeBlocksByKey: counts(doc.oversizeBlocksByKey),
    maxBlockSize: doc.maxBlockSize,
    finishedAt: doc.finishedAt,
  };
}

export function createMongoCandidateRepository(): CandidateRepository {
  return {
    async findSummary(projectId) {
      const doc = await CandidateSummaryModel.findOne({ projectId }).lean<CandidateSummaryDoc>();
      return doc ? toCandidateSummary(doc) : null;
    },
    async listPairs(projectId, { runId, afterPosition, limit }) {
      const docs = await CandidatePairModel.find({
        projectId,
        runId,
        position: { $gt: afterPosition },
      })
        .sort({ position: 1 })
        .limit(limit)
        .lean<CandidatePairDoc[]>();
      return docs.map((doc) => ({
        position: doc.position,
        recordA: doc.recordA.toHexString(),
        recordB: doc.recordB.toHexString(),
        keys: [...doc.keys],
      }));
    },
    async deleteByProject(projectId) {
      await CandidatePairModel.deleteMany({ projectId });
      await CandidateSummaryModel.deleteMany({ projectId });
    },
  };
}
