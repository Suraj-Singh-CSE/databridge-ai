import mongoose, { Types, type mongo } from 'mongoose';

import { AuditLogModel } from '../audit/audit.model.js';
import { ExportModel } from '../exports/export.model.js';
import type { ExportFormat } from '../exports/export.types.js';
import { QualityRunModel } from '../quality/quality.model.js';

import type { CollectionUsage, RetentionRepository } from './retention.types.js';

/** Collections holding one pipeline run's rows, keyed by `runId` (= `<jobId>:<attempt>`). */
const RUN_COLLECTIONS = [
  'staged_records',
  'candidate_pairs',
  'pair_scores',
  'clusters',
  'golden_records',
] as const;

const ACTIVE_STATUSES = ['queued', 'running'];

function database(): mongo.Db {
  const db = mongoose.connection.db;
  if (!db) throw new Error('not connected to mongodb');
  return db;
}

/** Run ids the summaries (and each source's standardisation) point at: the current runs. */
async function currentRunIds(db: mongo.Db): Promise<Set<string>> {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string') ids.add(value);
  };
  for (const name of ['candidate_summaries', 'score_summaries', 'cluster_summaries']) {
    const docs = await db
      .collection(name)
      .find({}, { projection: { runId: 1 } })
      .toArray();
    for (const doc of docs) add(doc.runId);
  }
  const sources = await db
    .collection('sources')
    .find({ 'standardisation.runId': { $exists: true } }, { projection: { standardisation: 1 } })
    .toArray();
  for (const doc of sources) add((doc.standardisation as { runId?: unknown } | null)?.runId);
  return ids;
}

/** Job ids (hex) of these run ids that are still queued or running; unparsable ids count too. */
async function activeJobIds(db: mongo.Db, runIds: string[]): Promise<Set<string>> {
  const hex = [...new Set(runIds.map((runId) => runId.split(':')[0] ?? ''))];
  const valid = hex.filter((id) => Types.ObjectId.isValid(id) && id.length === 24);
  const active = new Set(hex.filter((id) => !valid.includes(id)));
  const docs = await db
    .collection('jobs')
    .find(
      { _id: { $in: valid.map((id) => new Types.ObjectId(id)) }, status: { $in: ACTIVE_STATUSES } },
      { projection: { _id: 1 } },
    )
    .toArray();
  for (const doc of docs) active.add(String(doc._id));
  return active;
}

async function usageOf(db: mongo.Db, name: string): Promise<CollectionUsage> {
  const collection = db.collection(name);
  try {
    const [stats] = await collection.aggregate([{ $collStats: { storageStats: {} } }]).toArray();
    const storage = (stats?.storageStats ?? {}) as Record<string, unknown>;
    const num = (value: unknown) => (typeof value === 'number' ? value : null);
    return {
      name,
      documents: num(storage.count) ?? (await collection.estimatedDocumentCount()),
      dataBytes: num(storage.size),
      storageBytes: num(storage.storageSize),
      indexBytes: num(storage.totalIndexSize),
    };
  } catch {
    // Shared tiers may refuse $collStats: document counts still help.
    return {
      name,
      documents: await collection.estimatedDocumentCount(),
      dataBytes: null,
      storageBytes: null,
      indexBytes: null,
    };
  }
}

export function createMongoRetentionRepository(): RetentionRepository {
  return {
    async listExportsBefore(cutoff, limit) {
      const docs = await ExportModel.find(
        { createdAt: { $lt: cutoff } },
        { projectId: 1, format: 1 },
      )
        .sort({ createdAt: 1 })
        .limit(limit)
        .lean<{ _id: Types.ObjectId; projectId: Types.ObjectId; format: ExportFormat }[]>();
      return docs.map((d) => ({
        id: d._id.toHexString(),
        projectId: d.projectId.toHexString(),
        format: d.format,
      }));
    },

    async pruneQualityRuns(cutoff) {
      const newest = await QualityRunModel.aggregate<{ keep: Types.ObjectId }>([
        { $sort: { projectId: 1, startedAt: -1 } },
        { $group: { _id: '$projectId', keep: { $first: '$_id' } } },
      ]);
      const result = await QualityRunModel.deleteMany({
        startedAt: { $lt: cutoff },
        _id: { $nin: newest.map((n) => n.keep) },
      });
      return result.deletedCount;
    },

    async trimAudit(maxPerProject) {
      const over = await AuditLogModel.aggregate<{ _id: Types.ObjectId | null }>([
        { $group: { _id: '$projectId', count: { $sum: 1 } } },
        { $match: { count: { $gt: maxPerProject } } },
      ]);
      let deleted = 0;
      for (const { _id: projectId } of over) {
        // The newest entry past the cap; it and everything older go.
        const [edge] = await AuditLogModel.find({ projectId })
          .sort({ createdAt: -1, _id: -1 })
          .skip(maxPerProject)
          .limit(1)
          .lean<{ _id: Types.ObjectId; createdAt: Date }[]>();
        if (!edge) continue;
        // The model refuses deletes (append-only); this capped trim is the one exception.
        const result = await AuditLogModel.collection.deleteMany({
          projectId,
          $or: [
            { createdAt: { $lt: edge.createdAt } },
            { createdAt: edge.createdAt, _id: { $lte: edge._id } },
          ],
        });
        deleted += result.deletedCount;
      }
      return deleted;
    },

    async deleteOrphanRuns() {
      const db = database();
      // Order matters: run ids present, then which jobs are active, then the current runs. A
      // finished job wrote its summary before it finished, so its run is current or orphaned.
      const present = new Map<string, string[]>();
      for (const name of RUN_COLLECTIONS) {
        const runIds = await db.collection(name).distinct('runId');
        present.set(
          name,
          runIds.filter((id): id is string => typeof id === 'string'),
        );
      }
      const active = await activeJobIds(db, [...present.values()].flat());
      const current = await currentRunIds(db);
      let deleted = 0;
      for (const [name, runIds] of present) {
        const orphaned = runIds.filter(
          (runId) => !current.has(runId) && !active.has(runId.split(':')[0] ?? ''),
        );
        if (orphaned.length === 0) continue;
        const result = await db.collection(name).deleteMany({ runId: { $in: orphaned } });
        deleted += result.deletedCount;
      }
      return deleted;
    },

    async collectionUsage() {
      const db = database();
      const names = (await db.listCollections({}, { nameOnly: true }).toArray())
        .map((c) => c.name)
        .filter((name) => !name.startsWith('system.'));
      const usage = await Promise.all(names.map((name) => usageOf(db, name)));
      return usage.sort(
        (a, b) => (b.storageBytes ?? 0) - (a.storageBytes ?? 0) || b.documents - a.documents,
      );
    },
  };
}
