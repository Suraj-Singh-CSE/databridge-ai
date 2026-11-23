import { Types } from 'mongoose';

import { QualityRulesModel, QualityRunModel } from './quality.model.js';
import type {
  QualityRepository,
  QualityResult,
  QualityRuleOverrides,
  QualityRules,
  QualityRun,
  QualityRunSummary,
  QualitySource,
} from './quality.types.js';

const oid = (id: string) => new Types.ObjectId(id);
const hex = (id: unknown) => (id instanceof Types.ObjectId ? id.toHexString() : null);

/** What the worker stores (apps/ai-service handlers/quality.py). */
interface StoredRun {
  _id: Types.ObjectId;
  projectId: Types.ObjectId;
  jobId: Types.ObjectId;
  startedAt: Date;
  finishedAt: Date;
  source: Omit<QualitySource, 'versionId'> & { versionId: Types.ObjectId | null };
  clusteringRunId: string;
  schemaVersion?: number | null;
  rowCount: number;
  status: QualityRun['status'];
  statusCounts: QualityRun['statusCounts'];
  ruleCount: number;
  results?: QualityResult[];
  config?: Record<string, unknown>;
  createdBy?: Types.ObjectId | null;
}

interface StoredRules {
  projectId: Types.ObjectId;
  rules?: QualityRules['rules'];
  fields?: QualityRules['fields'];
  updatedBy?: Types.ObjectId | null;
  updatedAt?: Date | null;
}

function toSummary(doc: StoredRun): QualityRunSummary {
  return {
    id: doc._id.toHexString(),
    projectId: doc.projectId.toHexString(),
    jobId: doc.jobId.toHexString(),
    startedAt: doc.startedAt,
    finishedAt: doc.finishedAt,
    source: { ...doc.source, versionId: hex(doc.source.versionId) },
    clusteringRunId: doc.clusteringRunId,
    schemaVersion: doc.schemaVersion ?? null,
    rowCount: doc.rowCount,
    status: doc.status,
    statusCounts: doc.statusCounts,
    ruleCount: doc.ruleCount,
    createdBy: hex(doc.createdBy),
  };
}

const toRun = (doc: StoredRun): QualityRun => ({
  ...toSummary(doc),
  results: doc.results ?? [],
  config: doc.config ?? {},
});

function toRules(doc: StoredRules): QualityRules {
  return {
    rules: doc.rules ?? {},
    fields: doc.fields ?? {},
    updatedBy: hex(doc.updatedBy),
    updatedAt: doc.updatedAt ?? null,
  };
}

const NEWEST = { startedAt: -1, _id: -1 } as const;

export function createMongoQualityRepository(): QualityRepository {
  return {
    async listRuns(projectId, { skip, limit }) {
      const filter = { projectId: oid(projectId) };
      const [docs, total] = await Promise.all([
        QualityRunModel.find(filter, { results: 0, config: 0 })
          .sort(NEWEST)
          .skip(skip)
          .limit(limit)
          .lean<StoredRun[]>(),
        QualityRunModel.countDocuments(filter),
      ]);
      return { items: docs.map(toSummary), total };
    },

    async findRun(projectId, runId) {
      const doc = await QualityRunModel.findOne({
        _id: oid(runId),
        projectId: oid(projectId),
      }).lean<StoredRun>();
      return doc ? toRun(doc) : null;
    },

    async latestRun(projectId) {
      const doc = await QualityRunModel.findOne({ projectId: oid(projectId) })
        .sort(NEWEST)
        .lean<StoredRun>();
      return doc ? toRun(doc) : null;
    },

    async findRules(projectId) {
      const doc = await QualityRulesModel.findOne({
        projectId: oid(projectId),
      }).lean<StoredRules>();
      return doc ? toRules(doc) : null;
    },

    async saveRules(projectId, overrides: QualityRuleOverrides, by, at) {
      const doc = {
        projectId: oid(projectId),
        rules: overrides.rules,
        fields: overrides.fields,
        updatedBy: oid(by),
        updatedAt: at,
      };
      await QualityRulesModel.replaceOne({ projectId: doc.projectId }, doc, { upsert: true });
      return toRules(doc);
    },

    async deleteByProject(projectId) {
      await QualityRunModel.deleteMany({ projectId: oid(projectId) });
      await QualityRulesModel.deleteMany({ projectId: oid(projectId) });
    },
  };
}
