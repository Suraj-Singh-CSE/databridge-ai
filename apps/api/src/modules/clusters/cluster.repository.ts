import type { Types } from 'mongoose';

import {
  ClusterModel,
  ClusterSummaryModel,
  GoldenRecordModel,
  type ClusterDoc,
  type ClusterSummaryDoc,
  type GoldenRecordDoc,
} from './cluster.model.js';
import type {
  Cluster,
  ClusterRepository,
  ClusterSummary,
  FieldProvenance,
  GoldenRecord,
  SurvivorshipRule,
} from './cluster.types.js';

/** Provenance as the worker stores it: ObjectIds inside a Mixed field. */
interface StoredProvenance {
  recordId: Types.ObjectId | null;
  source: string | null;
  rule: SurvivorshipRule | null;
  alternatives: { value: string; count: number; recordIds: Types.ObjectId[]; sources: string[] }[];
}

function toSummary(doc: ClusterSummaryDoc): ClusterSummary {
  return {
    jobId: doc.jobId.toHexString(),
    runId: doc.runId,
    scoresRunId: doc.scoresRunId,
    candidatesRunId: doc.candidatesRunId,
    aiReviewJobId: doc.aiReviewJobId ?? null,
    recordCount: doc.recordCount,
    clusterCount: doc.clusterCount,
    singletonCount: doc.singletonCount,
    multiRecordCount: doc.multiRecordCount,
    needsReviewCount: doc.needsReviewCount,
    aiSuggestedCount: doc.aiSuggestedCount,
    averageSize: doc.averageSize,
    largestCluster: doc.largestCluster,
    decisionCount: doc.decisionCount,
    settings: {
      includeAiSuggested: doc.settings.includeAiSuggested,
      maxClusterSize: doc.settings.maxClusterSize,
      sourceTrust: [...doc.settings.sourceTrust],
    },
    finishedAt: doc.finishedAt,
  };
}

function toCluster(doc: ClusterDoc): Cluster {
  return {
    position: doc.position,
    customerId: doc.customerId,
    memberRecordIds: doc.memberRecordIds.map((id) => id.toHexString()),
    size: doc.size,
    confidence: doc.confidence ?? null,
    label: doc.label ?? null,
    status: doc.status,
    flags: [...doc.flags],
    reasons: [...doc.reasons],
    aiSuggested: doc.aiSuggested,
    links: doc.links.map(({ recordA, recordB, score, kind, tree }) => ({
      recordA: recordA.toHexString(),
      recordB: recordB.toHexString(),
      score,
      kind,
      tree,
    })),
  };
}

function toProvenance(stored: StoredProvenance): FieldProvenance {
  return {
    recordId: stored.recordId ? stored.recordId.toHexString() : null,
    source: stored.source,
    rule: stored.rule,
    alternatives: stored.alternatives.map(({ value, count, recordIds, sources }) => ({
      value,
      count,
      recordIds: recordIds.map((id) => id.toHexString()),
      sources: [...sources],
    })),
  };
}

function toGolden(doc: GoldenRecordDoc): GoldenRecord {
  const provenance = doc.provenance as Record<string, StoredProvenance>;
  return {
    customerId: doc.customerId,
    status: doc.status,
    fields: doc.fields as Record<string, string | null>,
    provenance: Object.fromEntries(
      Object.entries(provenance).map(([field, stored]) => [field, toProvenance(stored)]),
    ),
  };
}

export function createMongoClusterRepository(): ClusterRepository {
  return {
    async findSummary(projectId) {
      const doc = await ClusterSummaryModel.findOne({ projectId }).lean<ClusterSummaryDoc>();
      return doc ? toSummary(doc) : null;
    },
    async listClusters(projectId, { runId, status, flag, minSize, afterPosition, limit }) {
      const docs = await ClusterModel.find({
        projectId,
        runId,
        ...(status ? { status } : {}),
        ...(flag ? { flags: flag } : {}),
        ...(minSize ? { size: { $gte: minSize } } : {}),
        position: { $gt: afterPosition },
      })
        .sort({ position: 1 })
        .limit(limit)
        .lean<ClusterDoc[]>();
      return docs.map(toCluster);
    },
    async findCluster(projectId, runId, customerId) {
      const doc = await ClusterModel.findOne({ projectId, runId, customerId }).lean<ClusterDoc>();
      return doc ? toCluster(doc) : null;
    },
    async findGolden(projectId, runId, customerIds) {
      const docs = await GoldenRecordModel.find({
        projectId,
        runId,
        customerId: { $in: customerIds },
      }).lean<GoldenRecordDoc[]>();
      return docs.map(toGolden);
    },
    async deleteByProject(projectId) {
      await ClusterModel.deleteMany({ projectId });
      await GoldenRecordModel.deleteMany({ projectId });
      await ClusterSummaryModel.deleteMany({ projectId });
    },
  };
}
