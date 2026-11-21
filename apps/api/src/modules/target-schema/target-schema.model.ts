import { Schema, model, type InferSchemaType } from 'mongoose';

import { FIELD_TYPES } from './target-schema.types.js';

const targetFieldSchema = new Schema(
  {
    name: { type: String, required: true },
    type: { type: String, enum: FIELD_TYPES, required: true },
    format: { type: String, default: null },
    description: { type: String, default: '' },
    isPii: { type: Boolean, default: false },
    generated: { type: Boolean, default: false },
    required: { type: Boolean, default: false },
    allowConcat: { type: Boolean, default: false },
  },
  { _id: false },
);

// Read by the mapping worker (apps/ai-service/app/mapping/store.py): field names are shared.
const targetSchemaSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    name: { type: String, required: true },
    version: { type: Number, required: true, min: 1 },
    fields: { type: [targetFieldSchema], default: [] },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, collection: 'target_schemas' },
);

targetSchemaSchema.index({ projectId: 1 }, { unique: true });

export type TargetSchemaDoc = InferSchemaType<typeof targetSchemaSchema>;
export const TargetSchemaModel = model('TargetSchema', targetSchemaSchema);
