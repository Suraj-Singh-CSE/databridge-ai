import { Schema, model, type InferSchemaType } from 'mongoose';

import { EXPORT_FORMATS, EXPORT_SCOPES } from './export.types.js';

// Written by the Python worker (apps/ai-service/app/export/store.py); field names shared.
const exportSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true },
    format: { type: String, enum: EXPORT_FORMATS, required: true },
    scope: { type: String, enum: EXPORT_SCOPES, required: true },
    includeSources: { type: Boolean, default: false },
    rowCount: { type: Number, required: true },
    bytes: { type: Number, required: true },
    sha256: { type: String, required: true },
    fileKey: { type: String, required: true },
    clusteringRunId: { type: String, required: true },
    schemaVersion: { type: Number, default: null },
    status: { type: String, enum: ['ready'], required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdAt: { type: Date, required: true },
  },
  { collection: 'exports' },
);

// Same index the worker creates.
exportSchema.index({ projectId: 1, createdAt: -1 });

export type ExportDoc = InferSchemaType<typeof exportSchema>;
export const ExportModel = model('Export', exportSchema);
