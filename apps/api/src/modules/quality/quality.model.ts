import { Schema, model } from 'mongoose';

// Reports of `quality` jobs: written by the Python worker only (apps/ai-service
// app/quality/store.py), read here. Field names are shared; `strict: false` keeps them all.
const qualityRunSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true },
    startedAt: { type: Date, required: true },
  },
  { collection: 'quality_runs', strict: false },
);
// Same index the worker creates.
qualityRunSchema.index({ projectId: 1, startedAt: -1 });
export const QualityRunModel = model('QualityRun', qualityRunSchema);

// A project's threshold overrides (ADR 0022); the worker reads and validates them again.
const qualityRulesSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    rules: { type: Schema.Types.Mixed, default: {} },
    fields: { type: Schema.Types.Mixed, default: {} },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedAt: { type: Date, default: null },
  },
  { collection: 'quality_rules', minimize: false },
);
qualityRulesSchema.index({ projectId: 1 }, { unique: true });
export const QualityRulesModel = model('QualityRules', qualityRulesSchema);
