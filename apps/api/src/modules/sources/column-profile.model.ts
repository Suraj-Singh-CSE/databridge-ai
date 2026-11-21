import { Schema, model, type InferSchemaType } from 'mongoose';

import { INFERRED_TYPES } from './column-profile.types.js';

/**
 * Written by the Python profiler (apps/ai-service/app/profiling/store.py); the api only reads and
 * deletes. Field names are shared with it. Nested arrays are kept loose (Mixed): their shape is
 * owned by the profiler's Pydantic models and checked when read.
 */
const columnProfileSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    sourceId: { type: Schema.Types.ObjectId, ref: 'Source', required: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true },
    runId: { type: String, required: true },
    profileVersion: { type: Number, required: true },
    column: { type: String, required: true },
    position: { type: Number, required: true },
    inferredType: { type: String, enum: INFERRED_TYPES, required: true },
    rowCount: { type: Number, required: true },
    emptyCount: { type: Number, required: true },
    emptyPercent: { type: Number, required: true },
    distinctCount: { type: Number, required: true },
    uniquePercent: { type: Number, required: true },
    min: { type: Schema.Types.Mixed, default: null },
    max: { type: Schema.Types.Mixed, default: null },
    minLength: { type: Number, default: null },
    maxLength: { type: Number, default: null },
    avgLength: { type: Number, default: null },
    topValues: { type: [Schema.Types.Mixed], default: [] },
    samples: { type: [String], default: [] },
    patterns: { type: [Schema.Types.Mixed], default: [] },
    flags: { type: [Schema.Types.Mixed], default: [] },
    personal: { type: Boolean, required: true },
    createdAt: { type: Date, required: true },
  },
  { collection: 'column_profiles' },
);

// One profile per column of a source; the profiler creates the same index.
columnProfileSchema.index({ projectId: 1, sourceId: 1, column: 1 }, { unique: true });

export type ColumnProfileDoc = InferSchemaType<typeof columnProfileSchema>;
export const ColumnProfileModel = model('ColumnProfile', columnProfileSchema);
