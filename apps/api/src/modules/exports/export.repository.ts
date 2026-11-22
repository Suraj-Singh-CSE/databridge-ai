import { Types } from 'mongoose';

import { ExportModel, type ExportDoc } from './export.model.js';
import type { ExportRecord, ExportRepository } from './export.types.js';

type StoredExport = ExportDoc & { _id: Types.ObjectId };

const oid = (id: string) => new Types.ObjectId(id);

function toExport(doc: StoredExport): ExportRecord {
  return {
    id: doc._id.toHexString(),
    projectId: doc.projectId.toHexString(),
    jobId: doc.jobId.toHexString(),
    format: doc.format,
    scope: doc.scope,
    includeSources: doc.includeSources,
    rowCount: doc.rowCount,
    bytes: doc.bytes,
    sha256: doc.sha256,
    fileKey: doc.fileKey,
    clusteringRunId: doc.clusteringRunId,
    schemaVersion: doc.schemaVersion ?? null,
    status: doc.status,
    createdBy: doc.createdBy ? doc.createdBy.toHexString() : null,
    createdAt: doc.createdAt,
  };
}

export function createMongoExportRepository(): ExportRepository {
  return {
    async listByProject(projectId, limit) {
      const docs = await ExportModel.find({ projectId: oid(projectId) })
        .sort({ createdAt: -1, _id: -1 })
        .limit(limit)
        .lean<StoredExport[]>();
      return docs.map(toExport);
    },
    async findById(projectId, exportId) {
      const doc = await ExportModel.findOne({
        _id: oid(exportId),
        projectId: oid(projectId),
      }).lean<StoredExport>();
      return doc ? toExport(doc) : null;
    },
    async delete(projectId, exportId) {
      const result = await ExportModel.deleteOne({ _id: oid(exportId), projectId: oid(projectId) });
      return result.deletedCount > 0;
    },
    async deleteByProject(projectId) {
      await ExportModel.deleteMany({ projectId: oid(projectId) });
    },
  };
}
