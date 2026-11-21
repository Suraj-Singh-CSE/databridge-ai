import { Schema, model, type InferSchemaType } from 'mongoose';

import { DECISIONS, MAPPING_METHODS, MAPPING_ROLES } from './mapping.types.js';

/**
 * Written by the mapping worker (apps/ai-service/app/mapping/store.py); the api reads and deletes.
 * `suggestion` is owned by the worker's Pydantic model and kept loose (Mixed) here.
 */
const mappingSuggestionSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    sourceId: { type: Schema.Types.ObjectId, ref: 'Source', required: true },
    column: { type: String, required: true },
    position: { type: Number, required: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true },
    runId: { type: String, required: true },
    schemaVersion: { type: Number, required: true },
    mappingVersion: { type: Number, required: true },
    method: { type: String, enum: MAPPING_METHODS, required: true },
    model: { type: String, default: null },
    suggestion: { type: Schema.Types.Mixed, required: true },
    createdAt: { type: Date, required: true },
  },
  { collection: 'mapping_suggestions' },
);
// One suggestion per column of a source; the worker creates the same index.
mappingSuggestionSchema.index({ projectId: 1, sourceId: 1, column: 1 }, { unique: true });

const mappingDecisionSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    sourceId: { type: Schema.Types.ObjectId, ref: 'Source', required: true },
    column: { type: String, required: true },
    decision: { type: String, enum: DECISIONS, required: true },
    target: { type: String, default: null },
    role: { type: String, enum: MAPPING_ROLES, required: true },
    transform: { type: String, default: null },
    schemaVersion: { type: Number, required: true },
    decidedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    decidedAt: { type: Date, required: true },
  },
  { collection: 'mapping_decisions' },
);
mappingDecisionSchema.index({ projectId: 1, sourceId: 1, column: 1 }, { unique: true });

export type MappingSuggestionDoc = InferSchemaType<typeof mappingSuggestionSchema>;
export type MappingDecisionDoc = InferSchemaType<typeof mappingDecisionSchema>;
export const MappingSuggestionModel = model('MappingSuggestion', mappingSuggestionSchema);
export const MappingDecisionModel = model('MappingDecision', mappingDecisionSchema);
