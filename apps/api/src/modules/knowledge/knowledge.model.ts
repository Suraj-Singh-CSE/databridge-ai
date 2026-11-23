import { Schema, model } from 'mongoose';

// Written by the Python worker only (apps/ai-service app/knowledge/store.py), read here.
// Field names are shared; `strict: false` keeps them all.
const knowledgeSummarySchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true },
    finishedAt: { type: Date, required: true },
  },
  { collection: 'knowledge_summaries', strict: false },
);
// Same index the worker creates.
knowledgeSummarySchema.index({ projectId: 1 }, { unique: true });
export const KnowledgeSummaryModel = model('KnowledgeSummary', knowledgeSummarySchema);
