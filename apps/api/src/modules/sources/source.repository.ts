import type { Types } from 'mongoose';

import { DuplicateKeyError } from '../../errors.js';
import { isDuplicateKeyError } from '../../mongo-errors.js';

import { SourceModel, type SourceDoc } from './source.model.js';
import type { Source, SourceRepository } from './source.types.js';

type StoredSource = SourceDoc & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

function toSource(doc: StoredSource): Source {
  return {
    id: doc._id.toHexString(),
    projectId: doc.projectId.toHexString(),
    name: doc.name,
    systemName: doc.systemName ?? null,
    originalFilename: doc.originalFilename,
    fileKey: doc.fileKey,
    format: doc.format,
    sizeBytes: doc.sizeBytes,
    sha256: doc.sha256,
    status: doc.status,
    rowCount: doc.rowCount ?? null,
    columnCount: doc.columnCount ?? null,
    error: doc.error ? { code: doc.error.code, message: doc.error.message } : null,
    profiledAt: doc.profiledAt ?? null,
    standardisedAt: doc.standardisedAt ?? null,
    standardisation: doc.standardisation
      ? {
          runId: doc.standardisation.runId,
          rowCount: doc.standardisation.rowCount,
          rowsWithIssues: doc.standardisation.rowsWithIssues,
          issues: doc.standardisation.issues.map(({ field, code, count }) => ({
            field,
            code,
            count,
          })),
        }
      : null,
    uploadedBy: doc.uploadedBy.toHexString(),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

const AFTER_UPDATE = { new: true, runValidators: true } as const;

export function createMongoSourceRepository(): SourceRepository {
  return {
    async create({ id, ...input }) {
      try {
        const doc = await SourceModel.create({ _id: id, ...input });
        return toSource(doc.toObject());
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          throw new DuplicateKeyError('file already in project');
        }
        throw error;
      }
    },
    async findById(projectId, id) {
      const doc = await SourceModel.findOne({ _id: id, projectId }).lean<StoredSource>();
      return doc ? toSource(doc) : null;
    },
    async findBySha256(projectId, sha256) {
      const doc = await SourceModel.findOne({ projectId, sha256 }).lean<StoredSource>();
      return doc ? toSource(doc) : null;
    },
    async listByProject(projectId) {
      const docs = await SourceModel.find({ projectId })
        .sort({ createdAt: -1, _id: -1 })
        .lean<StoredSource[]>();
      return docs.map(toSource);
    },
    async countByProject(projectId) {
      return SourceModel.countDocuments({ projectId });
    },
    async update(projectId, id, patch) {
      const defined = Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== undefined),
      );
      const doc = await SourceModel.findOneAndUpdate(
        { _id: id, projectId },
        { $set: defined },
        AFTER_UPDATE,
      ).lean<StoredSource>();
      return doc ? toSource(doc) : null;
    },
    async delete(projectId, id) {
      const result = await SourceModel.deleteOne({ _id: id, projectId });
      return result.deletedCount === 1;
    },
    async deleteByProject(projectId) {
      const result = await SourceModel.deleteMany({ projectId });
      return result.deletedCount;
    },
  };
}
