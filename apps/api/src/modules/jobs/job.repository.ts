import type { Types } from 'mongoose';

import { JobModel, type JobDoc } from './job.model.js';
import type { Job, JobRepository, JobStatus } from './job.types.js';

type StoredJob = JobDoc & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

const ACTIVE: JobStatus[] = ['queued', 'running'];

function toJob(doc: StoredJob): Job {
  return {
    id: doc._id.toHexString(),
    projectId: doc.projectId.toHexString(),
    type: doc.type,
    status: doc.status,
    progress: doc.progress,
    message: doc.message,
    payload: (doc.payload as Record<string, unknown> | null | undefined) ?? {},
    result: (doc.result as Record<string, unknown> | null | undefined) ?? null,
    error: doc.error ? { code: doc.error.code, message: doc.error.message } : null,
    attempts: doc.attempts,
    createdBy: doc.createdBy.toHexString(),
    queuedAt: doc.queuedAt,
    startedAt: doc.startedAt ?? null,
    finishedAt: doc.finishedAt ?? null,
    heartbeatAt: doc.heartbeatAt ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

const AFTER_UPDATE = { new: true } as const;

export function createMongoJobRepository(): JobRepository {
  return {
    async create(input) {
      const doc = await JobModel.create({ ...input, queuedAt: new Date() });
      return toJob(doc.toObject());
    },
    async findById(id) {
      const doc = await JobModel.findById(id).lean<StoredJob>();
      return doc ? toJob(doc) : null;
    },
    async listByProject(projectId, limit) {
      const docs = await JobModel.find({ projectId })
        .sort({ createdAt: -1, _id: -1 })
        .limit(limit)
        .lean<StoredJob[]>();
      return docs.map(toJob);
    },
    async listActive(projectId, type) {
      const docs = await JobModel.find({ projectId, type, status: { $in: ACTIVE } }).lean<
        StoredJob[]
      >();
      return docs.map(toJob);
    },
    async finishIfActive(id, { status, message, error }, at) {
      const doc = await JobModel.findOneAndUpdate(
        { _id: id, status: { $in: ACTIVE } },
        { $set: { status, message, error, finishedAt: at } },
        AFTER_UPDATE,
      ).lean<StoredJob>();
      return doc ? toJob(doc) : null;
    },
    async failIfStale(id, cutoff, error, at) {
      const doc = await JobModel.findOneAndUpdate(
        {
          _id: id,
          status: 'running',
          $or: [{ heartbeatAt: { $lt: cutoff } }, { heartbeatAt: null }],
        },
        { $set: { status: 'failed', message: error.message, error, finishedAt: at } },
        AFTER_UPDATE,
      ).lean<StoredJob>();
      return doc ? toJob(doc) : null;
    },
    async deleteByProject(projectId) {
      const result = await JobModel.deleteMany({ projectId });
      return result.deletedCount;
    },
  };
}
