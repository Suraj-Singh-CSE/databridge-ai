import { Schema, model, type InferSchemaType } from 'mongoose';

import {
  CLUSTER_FLAGS,
  CLUSTER_STATUSES,
  CONFIDENCE_LABELS,
  DECISION_ACTIONS,
  LINK_KINDS,
  PAIR_DECISIONS,
} from './cluster.types.js';

/** Written by the clustering worker (apps/ai-service/app/matching/cluster_store.py); the api reads. */
const clusterSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true },
    runId: { type: String, required: true },
    position: { type: Number, required: true },
    customerId: { type: String, required: true },
    memberRecordIds: { type: [Schema.Types.ObjectId], ref: 'StagedRecord', default: [] },
    size: { type: Number, required: true },
    confidence: { type: Number, default: null },
    label: { type: String, enum: [...CONFIDENCE_LABELS, null], default: null },
    status: { type: String, enum: CLUSTER_STATUSES, required: true },
    flags: { type: [{ type: String, enum: CLUSTER_FLAGS }], default: [] },
    reasons: { type: [String], default: [] },
    aiSuggested: { type: Boolean, required: true },
    links: {
      type: [
        new Schema(
          {
            recordA: { type: Schema.Types.ObjectId, ref: 'StagedRecord', required: true },
            recordB: { type: Schema.Types.ObjectId, ref: 'StagedRecord', required: true },
            score: { type: Number, required: true },
            kind: { type: String, enum: LINK_KINDS, required: true },
            tree: { type: Boolean, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    createdAt: { type: Date, required: true },
  },
  { collection: 'clusters' },
);
// The worker creates the same indexes.
clusterSchema.index({ projectId: 1, runId: 1, position: 1 }, { unique: true });
clusterSchema.index({ projectId: 1, runId: 1, customerId: 1 }, { unique: true });

const goldenRecordSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true },
    runId: { type: String, required: true },
    customerId: { type: String, required: true },
    status: { type: String, enum: CLUSTER_STATUSES, required: true },
    // Target field -> value; field -> { recordId, source, rule, alternatives[] }. Shapes owned
    // by the worker (survivorship.py).
    fields: { type: Schema.Types.Mixed, required: true },
    provenance: { type: Schema.Types.Mixed, required: true },
    createdAt: { type: Date, required: true },
  },
  { collection: 'golden_records' },
);
goldenRecordSchema.index({ projectId: 1, runId: 1, customerId: 1 }, { unique: true });

const clusterSummarySchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true },
    runId: { type: String, required: true },
    scoresRunId: { type: String, required: true },
    candidatesRunId: { type: String, required: true },
    aiReviewJobId: { type: String, default: null },
    recordCount: { type: Number, required: true },
    clusterCount: { type: Number, required: true },
    singletonCount: { type: Number, required: true },
    multiRecordCount: { type: Number, required: true },
    needsReviewCount: { type: Number, required: true },
    aiSuggestedCount: { type: Number, required: true },
    averageSize: { type: Number, required: true },
    largestCluster: { type: Number, required: true },
    decisionCount: { type: Number, required: true },
    // Written since M4.6b; summaries of earlier runs have none.
    staleDecisionCount: { type: Number, default: 0 },
    cutLinkCount: { type: Number, default: 0 },
    conflictingDecisionCount: { type: Number, default: 0 },
    settings: {
      type: new Schema(
        {
          includeAiSuggested: { type: Boolean, required: true },
          maxClusterSize: { type: Number, required: true },
          sourceTrust: { type: [String], default: [] },
        },
        { _id: false },
      ),
      required: true,
    },
    finishedAt: { type: Date, required: true },
  },
  { collection: 'cluster_summaries' },
);
clusterSummarySchema.index({ projectId: 1 }, { unique: true });

/** A person's same / different decision on two records; written here, read by the worker. */
const matchDecisionSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    recordA: { type: Schema.Types.ObjectId, ref: 'StagedRecord', required: true },
    recordB: { type: Schema.Types.ObjectId, ref: 'StagedRecord', required: true },
    keyA: { type: String, required: true },
    keyB: { type: String, required: true },
    decision: { type: String, enum: PAIR_DECISIONS, required: true },
    action: { type: String, enum: DECISION_ACTIONS, required: true },
    customerId: { type: String, required: true },
    reason: { type: String, default: null },
    decidedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    decidedAt: { type: Date, required: true },
    runId: { type: String, required: true },
  },
  { collection: 'match_decisions' },
);
matchDecisionSchema.index({ projectId: 1, keyA: 1, keyB: 1 }, { unique: true });
matchDecisionSchema.index({ projectId: 1, decidedAt: 1 });

const clusterApprovalSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    customerId: { type: String, required: true },
    memberKeys: { type: [String], default: [] },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    approvedAt: { type: Date, required: true },
    runId: { type: String, required: true },
  },
  { collection: 'cluster_approvals' },
);
clusterApprovalSchema.index({ projectId: 1, customerId: 1 }, { unique: true });
clusterApprovalSchema.index({ projectId: 1, memberKeys: 1 });

export type MatchDecisionDoc = InferSchemaType<typeof matchDecisionSchema>;
export type ClusterApprovalDoc = InferSchemaType<typeof clusterApprovalSchema>;
export const MatchDecisionModel = model('MatchDecision', matchDecisionSchema);
export const ClusterApprovalModel = model('ClusterApproval', clusterApprovalSchema);
export type ClusterDoc = InferSchemaType<typeof clusterSchema>;
export type GoldenRecordDoc = InferSchemaType<typeof goldenRecordSchema>;
export type ClusterSummaryDoc = InferSchemaType<typeof clusterSummarySchema>;
export const ClusterModel = model('Cluster', clusterSchema);
export const GoldenRecordModel = model('GoldenRecord', goldenRecordSchema);
export const ClusterSummaryModel = model('ClusterSummary', clusterSummarySchema);
