import {
  PairScoreModel,
  ScoreSummaryModel,
  type PairScoreDoc,
  type ScoreSummaryDoc,
} from './score.model.js';
import type { PairScore, ScoreRepository, ScoreSummary } from './score.types.js';

export function toScoreSummary(doc: ScoreSummaryDoc): ScoreSummary {
  const { model } = doc;
  return {
    jobId: doc.jobId.toHexString(),
    runId: doc.runId,
    candidatesRunId: doc.candidatesRunId,
    pairCount: doc.pairCount,
    bandCounts: doc.bandCounts.map(({ band, count }) => ({ band, count })),
    thresholds: { match: doc.thresholds.match, maybe: doc.thresholds.maybe },
    model: {
      method: model.method,
      emIterations: model.emIterations,
      emConverged: model.emConverged,
      fallbackReason: model.fallbackReason ?? null,
      matchProportion: model.matchProportion,
      priorWeight: model.priorWeight,
      fields: model.fields.map(({ field, levels }) => ({
        field,
        levels: levels.map(({ level, m, u, weight }) => ({ level, m, u, weight })),
      })),
    },
    finishedAt: doc.finishedAt,
  };
}

function toPairScore(doc: PairScoreDoc): PairScore {
  return {
    position: doc.position,
    recordA: doc.recordA.toHexString(),
    recordB: doc.recordB.toHexString(),
    score: doc.score,
    band: doc.band,
    matchWeight: doc.matchWeight,
    // Shape owned by the worker: field -> level.
    fieldLevels: doc.fieldLevels as Record<string, string>,
    reasons: doc.reasons.map(({ field, level, weight, text }) => ({ field, level, weight, text })),
  };
}

export function createMongoScoreRepository(): ScoreRepository {
  return {
    async findSummary(projectId) {
      const doc = await ScoreSummaryModel.findOne({ projectId }).lean<ScoreSummaryDoc>();
      return doc ? toScoreSummary(doc) : null;
    },
    async listScores(projectId, { runId, band, afterPosition, limit }) {
      const docs = await PairScoreModel.find({
        projectId,
        runId,
        ...(band ? { band } : {}),
        position: { $gt: afterPosition },
      })
        .sort({ position: 1 })
        .limit(limit)
        .lean<PairScoreDoc[]>();
      return docs.map(toPairScore);
    },
    async deleteByProject(projectId) {
      await PairScoreModel.deleteMany({ projectId });
      await ScoreSummaryModel.deleteMany({ projectId });
    },
  };
}
