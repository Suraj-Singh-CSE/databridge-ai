import { Schema, model, type InferSchemaType } from 'mongoose';

import { PROJECT_ROLES, PROJECT_STATUSES, PROJECT_STEPS } from './project.types.js';

const memberSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: PROJECT_ROLES, required: true },
  },
  { _id: false },
);

const projectSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 80 },
    description: { type: String, default: '', trim: true, maxlength: 500 },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    members: { type: [memberSchema], default: [] },
    status: { type: String, enum: PROJECT_STATUSES, default: 'active' },
    currentStep: { type: String, enum: PROJECT_STEPS, default: 'sources' },
  },
  { timestamps: true },
);

projectSchema.index({ 'members.userId': 1 });

export type ProjectDoc = InferSchemaType<typeof projectSchema>;
export const ProjectModel = model('Project', projectSchema);
