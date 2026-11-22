import {
  PairScoreModel,
  ScoreSummaryModel,
  type PairScoreDoc,
  type ScoreSummaryDoc,
} from './score.model.js';
import type {
  AiReviewSummary,
  PairScore,
  ScoreBand,
  ScoreRepository,
  ScoreSummary,
} from './score.types.js';

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
    aiReview: doc.aiReview ? toAiReview(doc.aiReview) : null,
  };
}

function toAiReview(review: NonNullable<ScoreSummaryDoc['aiReview']>): AiReviewSummary {
  return {
    jobId: review.jobId.toHexString(),
    promptVersion: review.promptVersion,
    model: review.model ?? null,
    confidenceThreshold: review.confidenceThreshold,
    pairCount: review.pairCount,
    reviewed: review.reviewed,
    same: review.same,
    different: review.different,
    unsure: review.unsure,
    unavailable: review.unavailable,
    suggestedMatch: review.suggestedMatch,
    suggestedNonMatch: review.suggestedNonMatch,
    calls: review.calls,
    failedCalls: review.failedCalls,
    finishedAt: review.finishedAt,
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
    aiStatus: doc.aiStatus ?? null,
    aiDecision: doc.aiDecision ?? null,
    aiConfidence: doc.aiConfidence ?? null,
    aiReason: doc.aiReason ?? null,
    aiModel: doc.aiModel ?? null,
    aiPromptVersion: doc.aiPromptVersion ?? null,
    reviewedAt: doc.reviewedAt ?? null,
    // Pairs scored but never reviewed have no suggestedBand stored: it is their band.
    suggestedBand: doc.suggestedBand ?? doc.band,
  };
}

/** `suggestedBand`, or `band` where the pair has none stored. */
function suggestedBandFilter(band: ScoreBand) {
  return { $or: [{ suggestedBand: band }, { suggestedBand: { $exists: false }, band }] };
}

export function createMongoScoreRepository(): ScoreRepository {
  return {
    async findSummary(projectId) {
      const doc = await ScoreSummaryModel.findOne({ projectId }).lean<ScoreSummaryDoc>();
      return doc ? toScoreSummary(doc) : null;
    },
    async listScores(projectId, { runId, band, suggestedBand, afterPosition, limit }) {
      const docs = await PairScoreModel.find({
        projectId,
        runId,
        ...(band ? { band } : {}),
        ...(suggestedBand ? suggestedBandFilter(suggestedBand) : {}),
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
