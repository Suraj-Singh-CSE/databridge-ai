import { Schema, model, type InferSchemaType } from 'mongoose';

/** Written by the candidates worker (apps/ai-service/app/matching/store.py); the api reads. */
const candidatePairSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true },
    runId: { type: String, required: true },
    position: { type: Number, required: true },
    recordA: { type: Schema.Types.ObjectId, ref: 'StagedRecord', required: true },
    recordB: { type: Schema.Types.ObjectId, ref: 'StagedRecord', required: true },
    keys: { type: [String], required: true },
    createdAt: { type: Date, required: true },
  },
  { collection: 'candidate_pairs' },
);
// One pair per position and run; the worker creates the same index.
candidatePairSchema.index({ projectId: 1, runId: 1, position: 1 }, { unique: true });

const keyCount = new Schema(
  { key: { type: String, required: true }, count: { type: Number, required: true } },
  { _id: false },
);

const candidateSummarySchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true },
    runId: { type: String, required: true },
    sources: {
      type: [
        new Schema(
          {
            sourceId: { type: String, required: true },
            runId: { type: String, required: true },
            rowCount: { type: Number, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    recordCount: { type: Number, required: true },
    possiblePairs: { type: Number, required: true },
    pairCount: { type: Number, required: true },
    reductionRatio: { type: Number, required: true },
    pairsByKey: { type: [keyCount], default: [] },
    pairsOnlyByKey: { type: [keyCount], default: [] },
    oversizeBlocksSkipped: { type: Number, required: true },
    oversizeBlocksByKey: { type: [keyCount], default: [] },
    maxBlockSize: { type: Number, required: true },
    finishedAt: { type: Date, required: true },
  },
  { collection: 'candidate_summaries' },
);
candidateSummarySchema.index({ projectId: 1 }, { unique: true });

export type CandidatePairDoc = InferSchemaType<typeof candidatePairSchema>;
export type CandidateSummaryDoc = InferSchemaType<typeof candidateSummarySchema>;
export const CandidatePairModel = model('CandidatePair', candidatePairSchema);
export const CandidateSummaryModel = model('CandidateSummary', candidateSummarySchema);
