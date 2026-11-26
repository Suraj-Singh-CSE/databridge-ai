import { Schema, model, type InferSchemaType } from 'mongoose';

import { JOB_STATUSES, JOB_TYPES } from './job.types.js';

const jobErrorSchema = new Schema(
  {
    code: { type: String, required: true },
    message: { type: String, required: true },
  },
  { _id: false },
);

// Field names are shared with the Python worker (apps/ai-service/app/worker/store.py).
const jobSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    type: { type: String, enum: JOB_TYPES, required: true },
    status: { type: String, enum: JOB_STATUSES, default: 'queued' },
    progress: { type: Number, min: 0, max: 100, default: 0 },
    message: { type: String, default: 'Waiting to start' },
    payload: { type: Schema.Types.Mixed, default: {} },
    result: { type: Schema.Types.Mixed, default: null },
    error: { type: jobErrorSchema, default: null },
    attempts: { type: Number, min: 0, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    queuedAt: { type: Date, required: true },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    heartbeatAt: { type: Date, default: null },
    // What an exclusive job locks while active: its sourceId, or `project` (G3-12). Absent for
    // job types that may run side by side (export, sql_run, demo).
    lockKey: { type: String },
  },
  // minimize: false keeps an empty payload `{}` instead of dropping the field.
  { timestamps: true, collection: 'jobs', minimize: false },
);

jobSchema.index({ projectId: 1, createdAt: -1 });
// One waiting job per lock (G3-12): two simultaneous starts both insert `queued`, so the second
// insert fails here instead of creating a duplicate job. A job that is already running blocks a
// new one through the service's check (it was queued, and alone, when that check last ran).
// Equality filters only: every MongoDB version accepts them in a partial index. Jobs without a
// lockKey (all jobs created before it existed) are outside the index, so it builds on old data.
jobSchema.index(
  { projectId: 1, type: 1, lockKey: 1 },
  {
    name: 'one_queued_job_per_lock',
    unique: true,
    partialFilterExpression: { status: 'queued', lockKey: { $exists: true } },
  },
);

export type JobDoc = InferSchemaType<typeof jobSchema>;
export const JobModel = model('Job', jobSchema);
