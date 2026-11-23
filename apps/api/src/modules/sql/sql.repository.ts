import { Types } from 'mongoose';

import { SqlRunModel, SqlVersionModel, type SqlVersionDoc } from './sql.model.js';
import type {
  SqlLastRun,
  SqlTestResults,
  SqlValidation,
  SqlVersion,
  SqlVersionRepository,
} from './sql.types.js';

type StoredVersion = SqlVersionDoc & { _id: Types.ObjectId };

const oid = (id: string) => new Types.ObjectId(id);
const hex = (id: Types.ObjectId | null | undefined) => (id ? id.toHexString() : null);

function toLastRun(raw: unknown): SqlLastRun | null {
  if (!raw || typeof raw !== 'object') return null;
  const run = raw as {
    runId?: Types.ObjectId;
    passed?: boolean;
    rowCount?: number;
    finishedAt?: Date;
  };
  return {
    runId: hex(run.runId) ?? '',
    passed: run.passed === true,
    rowCount: run.rowCount ?? 0,
    finishedAt: run.finishedAt ?? new Date(0),
  };
}

function toVersion(doc: StoredVersion): SqlVersion {
  return {
    id: doc._id.toHexString(),
    projectId: doc.projectId.toHexString(),
    jobId: doc.jobId.toHexString(),
    version: doc.version,
    sql: doc.sql,
    explanation: doc.explanation,
    assumptions: doc.assumptions,
    method: doc.method,
    model: doc.model ?? null,
    promptVersion: doc.promptVersion ?? null,
    fallbackReason: doc.fallbackReason ?? null,
    scope: doc.scope,
    instructions: doc.instructions ?? null,
    validation: doc.validation as SqlValidation,
    error: (doc.error as SqlVersion['error']) ?? null,
    tests: (doc.tests as SqlTestResults | null) ?? null,
    testsPassed: doc.testsPassed,
    attempts: doc.attempts as Record<string, unknown>[],
    usage: (doc.usage as Record<string, number> | null) ?? null,
    status: doc.status,
    createdBy: hex(doc.createdBy),
    createdAt: doc.createdAt,
    clusteringRunId: doc.clusteringRunId,
    schemaVersion: doc.schemaVersion ?? null,
    lastRun: toLastRun(doc.lastRun),
    approvedBy: hex(doc.approvedBy),
    approvedAt: doc.approvedAt ?? null,
    rejectedBy: hex(doc.rejectedBy),
    rejectedAt: doc.rejectedAt ?? null,
    rejectReason: doc.rejectReason ?? null,
    supersededAt: doc.supersededAt ?? null,
  };
}

export function createMongoSqlVersionRepository(): SqlVersionRepository {
  return {
    async listByProject(projectId, limit) {
      const docs = await SqlVersionModel.find({ projectId: oid(projectId) })
        .sort({ version: -1 })
        .limit(limit)
        .lean<StoredVersion[]>();
      return docs.map(toVersion);
    },

    async findById(projectId, versionId) {
      const doc = await SqlVersionModel.findOne({
        _id: oid(versionId),
        projectId: oid(projectId),
      }).lean<StoredVersion>();
      return doc ? toVersion(doc) : null;
    },

    async approve(projectId, versionId, by, at) {
      const approved = await SqlVersionModel.findOneAndUpdate(
        { _id: oid(versionId), projectId: oid(projectId), status: 'draft', testsPassed: true },
        { $set: { status: 'approved', approvedBy: oid(by), approvedAt: at } },
        { new: true },
      ).lean<StoredVersion>();
      if (!approved) return null;
      const others = {
        projectId: oid(projectId),
        status: 'approved' as const,
        _id: { $ne: approved._id },
      };
      const previous = await SqlVersionModel.find(others, { version: 1 }).lean<StoredVersion[]>();
      await SqlVersionModel.updateMany(others, {
        $set: { status: 'superseded', supersededAt: at },
      });
      return { version: toVersion(approved), superseded: previous.map((d) => d.version) };
    },

    async reject(projectId, versionId, by, at, reason) {
      const doc = await SqlVersionModel.findOneAndUpdate(
        {
          _id: oid(versionId),
          projectId: oid(projectId),
          status: { $in: ['draft', 'approved'] },
        },
        { $set: { status: 'rejected', rejectedBy: oid(by), rejectedAt: at, rejectReason: reason } },
        { new: true },
      ).lean<StoredVersion>();
      return doc ? toVersion(doc) : null;
    },

    async deleteByProject(projectId) {
      await SqlVersionModel.deleteMany({ projectId: oid(projectId) });
      await SqlRunModel.deleteMany({ projectId: oid(projectId) });
    },
  };
}
