import { Schema, model, type InferSchemaType } from 'mongoose';

import { SQL_METHODS, SQL_SCOPES, SQL_STATUSES } from './sql.types.js';

// Created by the Python worker (apps/ai-service/app/sql/store.py); field names shared. The api
// only changes the review fields (status, approvedBy/At, rejectedBy/At/Reason, supersededAt).
const sqlVersionSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true },
    version: { type: Number, required: true },
    sql: { type: String, required: true },
    explanation: { type: String, default: '' },
    assumptions: { type: [String], default: [] },
    method: { type: String, enum: SQL_METHODS, required: true },
    model: { type: String, default: null },
    promptVersion: { type: String, default: null },
    fallbackReason: { type: String, default: null },
    scope: { type: String, enum: SQL_SCOPES, required: true },
    instructions: { type: String, default: null },
    validation: { type: Schema.Types.Mixed, required: true },
    error: { type: Schema.Types.Mixed, default: null },
    tests: { type: Schema.Types.Mixed, default: null },
    testsPassed: { type: Boolean, required: true },
    attempts: { type: [Schema.Types.Mixed], default: [] },
    usage: { type: Schema.Types.Mixed, default: null },
    status: { type: String, enum: SQL_STATUSES, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdAt: { type: Date, required: true },
    clusteringRunId: { type: String, required: true },
    schemaVersion: { type: Number, default: null },
    lastRun: { type: Schema.Types.Mixed, default: null },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },
    rejectedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    rejectedAt: { type: Date, default: null },
    rejectReason: { type: String, default: null },
    supersededAt: { type: Date, default: null },
  },
  { collection: 'sql_versions' },
);

// Same index the worker creates.
sqlVersionSchema.index({ projectId: 1, version: 1 }, { unique: true });

/**
 * At most one approved version per project (G3-13). Not declared on the schema: it is built by
 * `ensureIndexes` (src/indexes.ts) after older duplicates are superseded, so an existing
 * database cannot stop the api from starting.
 */
export const ONE_APPROVED_SQL_INDEX = {
  name: 'one_approved_version_per_project',
  key: { projectId: 1 },
  partialFilterExpression: { status: 'approved' },
} as const;

export type SqlVersionDoc = InferSchemaType<typeof sqlVersionSchema>;
export const SqlVersionModel = model('SqlVersion', sqlVersionSchema);

// Run records of `sql_run` jobs (written by the worker only; read by later pipeline steps).
const sqlRunSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    versionId: { type: Schema.Types.ObjectId, ref: 'SqlVersion', required: true },
    createdAt: { type: Date, required: true },
  },
  { collection: 'sql_runs', strict: false },
);
sqlRunSchema.index({ projectId: 1, createdAt: -1 });
export const SqlRunModel = model('SqlRun', sqlRunSchema);
