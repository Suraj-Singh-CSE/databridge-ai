import { Types } from 'mongoose';

import { isDuplicateKeyError } from '../../mongo-errors.js';

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

/** Approve retries after losing the race to a simultaneous approval (G3-13). */
const APPROVE_ATTEMPTS = 5;

/** Undoes our own supersede; harmless when another version was approved since (E11000). */
async function restoreApproved(id: Types.ObjectId, at: Date): Promise<void> {
  try {
    await SqlVersionModel.updateOne(
      { _id: id, status: 'superseded', supersededAt: at },
      { $set: { status: 'approved', supersededAt: null } },
    );
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
  }
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

    async findApproved(projectId) {
      const doc = await SqlVersionModel.findOne({ projectId: oid(projectId), status: 'approved' })
        .sort({ version: -1 })
        .lean<StoredVersion>();
      return doc ? toVersion(doc) : null;
    },

    async approve(projectId, versionId, by, at) {
      const project = oid(projectId);
      const draft = {
        _id: oid(versionId),
        projectId: project,
        status: 'draft' as const,
        testsPassed: true,
      };
      const superseded: number[] = [];
      for (let attempt = 1; ; attempt += 1) {
        if (!(await SqlVersionModel.exists(draft))) return null;
        // Supersede first: the partial unique index allows one approved version per project.
        const current = await SqlVersionModel.findOneAndUpdate(
          { projectId: project, status: 'approved' },
          { $set: { status: 'superseded', supersededAt: at } },
          { returnDocument: 'after', projection: { version: 1 } },
        ).lean<StoredVersion>();
        if (current) superseded.push(current.version);
        try {
          const approved = await SqlVersionModel.findOneAndUpdate(
            draft,
            { $set: { status: 'approved', approvedBy: oid(by), approvedAt: at } },
            { returnDocument: 'after' },
          ).lean<StoredVersion>();
          if (approved) return { version: toVersion(approved), superseded };
        } catch (error) {
          // Another version was approved between the two writes: supersede it and try again.
          if (isDuplicateKeyError(error) && attempt < APPROVE_ATTEMPTS) continue;
          if (current) await restoreApproved(current._id, at);
          throw error;
        }
        // The target was decided by someone else meanwhile: put the previous approval back.
        if (current) await restoreApproved(current._id, at);
        return null;
      }
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
