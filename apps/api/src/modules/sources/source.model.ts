import { Schema, model, type InferSchemaType } from 'mongoose';

import { SOURCE_FORMATS, SOURCE_STATUSES } from './source.types.js';

const sourceErrorSchema = new Schema(
  {
    code: { type: String, required: true },
    message: { type: String, required: true },
  },
  { _id: false },
);

const sourceSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 80 },
    systemName: { type: String, default: null, trim: true, maxlength: 40 },
    originalFilename: { type: String, required: true, maxlength: 200 },
    fileKey: { type: String, required: true },
    format: { type: String, enum: SOURCE_FORMATS, required: true },
    sizeBytes: { type: Number, required: true, min: 0 },
    sha256: { type: String, required: true, match: /^[a-f\d]{64}$/ },
    status: { type: String, enum: SOURCE_STATUSES, default: 'uploaded' },
    rowCount: { type: Number, default: null, min: 0 },
    columnCount: { type: Number, default: null, min: 0 },
    error: { type: sourceErrorSchema, default: null },
    // Written by the profiler (apps/ai-service/app/profiling/store.py), with profileRunId, the
    // `<jobId>:<attempt>` that owns the current status.
    profiledAt: { type: Date, default: null },
    profileRunId: { type: String, default: null },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

sourceSchema.index({ projectId: 1, createdAt: -1 });
// The same file (by content) can be added to a project only once.
sourceSchema.index({ projectId: 1, sha256: 1 }, { unique: true });

export type SourceDoc = InferSchemaType<typeof sourceSchema>;
export const SourceModel = model('Source', sourceSchema);
