import { Schema, model, type InferSchemaType } from 'mongoose';

import { AI_DECISIONS, AI_STATUSES, SCORE_BANDS } from './score.types.js';

/** Written by the scoring worker (apps/ai-service/app/matching/scoring_store.py); the api reads. */
const pairScoreSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true },
    runId: { type: String, required: true },
    candidatesRunId: { type: String, required: true },
    position: { type: Number, required: true },
    recordA: { type: Schema.Types.ObjectId, ref: 'StagedRecord', required: true },
    recordB: { type: Schema.Types.ObjectId, ref: 'StagedRecord', required: true },
    score: { type: Number, required: true },
    band: { type: String, enum: SCORE_BANDS, required: true },
    matchWeight: { type: Number, required: true },
    // Field -> level; the field names are the scorer's.
    fieldLevels: { type: Schema.Types.Mixed, required: true },
    reasons: {
      type: [
        new Schema(
          {
            field: { type: String, required: true },
            level: { type: String, required: true },
            weight: { type: Number, required: true },
            text: { type: String, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    createdAt: { type: Date, required: true },
    // Set on maybe pairs by the pair_review job (apps/ai-service/app/matching/review_store.py).
    aiStatus: { type: String, enum: AI_STATUSES },
    aiDecision: { type: String, enum: AI_DECISIONS },
    aiConfidence: { type: Number },
    aiReason: { type: String },
    aiModel: { type: String },
    aiPromptVersion: { type: String },
    aiJobId: { type: Schema.Types.ObjectId, ref: 'Job' },
    reviewedAt: { type: Date },
    suggestedBand: { type: String, enum: SCORE_BANDS },
  },
  { collection: 'pair_scores' },
);
// The worker creates the same indexes.
pairScoreSchema.index({ projectId: 1, runId: 1, position: 1 }, { unique: true });
pairScoreSchema.index({ projectId: 1, runId: 1, band: 1, position: 1 });

const levelSchema = new Schema(
  {
    level: { type: String, required: true },
    m: { type: Number, required: true },
    u: { type: Number, required: true },
    weight: { type: Number, required: true },
  },
  { _id: false },
);

const scoreSummarySchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true },
    runId: { type: String, required: true },
    candidatesRunId: { type: String, required: true },
    pairCount: { type: Number, required: true },
    bandCounts: {
      type: [
        new Schema(
          {
            band: { type: String, enum: SCORE_BANDS, required: true },
            count: { type: Number, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    thresholds: {
      type: new Schema(
        { match: { type: Number, required: true }, maybe: { type: Number, required: true } },
        { _id: false },
      ),
      required: true,
    },
    model: {
      type: new Schema(
        {
          method: { type: String, enum: ['em', 'defaults'], required: true },
          emIterations: { type: Number, required: true },
          emConverged: { type: Boolean, required: true },
          fallbackReason: { type: String, default: null },
          matchProportion: { type: Number, required: true },
          priorWeight: { type: Number, required: true },
          fields: {
            type: [
              new Schema(
                {
                  field: { type: String, required: true },
                  levels: { type: [levelSchema], default: [] },
                },
                { _id: false },
              ),
            ],
            default: [],
          },
        },
        { _id: false },
      ),
      required: true,
    },
    finishedAt: { type: Date, required: true },
    aiReview: {
      type: new Schema(
        {
          jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true },
          promptVersion: { type: String, required: true },
          model: { type: String, default: null },
          confidenceThreshold: { type: Number, required: true },
          pairCount: { type: Number, required: true },
          reviewed: { type: Number, required: true },
          same: { type: Number, required: true },
          different: { type: Number, required: true },
          unsure: { type: Number, required: true },
          unavailable: { type: Number, required: true },
          suggestedMatch: { type: Number, required: true },
          suggestedNonMatch: { type: Number, required: true },
          calls: { type: Number, required: true },
          failedCalls: { type: Number, required: true },
          finishedAt: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
  },
  { collection: 'score_summaries' },
);
scoreSummarySchema.index({ projectId: 1 }, { unique: true });

export type PairScoreDoc = InferSchemaType<typeof pairScoreSchema>;
export type ScoreSummaryDoc = InferSchemaType<typeof scoreSummarySchema>;
export const PairScoreModel = model('PairScore', pairScoreSchema);
export const ScoreSummaryModel = model('ScoreSummary', scoreSummarySchema);
