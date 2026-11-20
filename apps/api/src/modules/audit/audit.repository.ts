import type { Types } from 'mongoose';

import { AuditLogModel, type AuditLogDoc } from './audit.model.js';
import type { AuditEntry, AuditRepository, Snapshot } from './audit.types.js';

type StoredEntry = AuditLogDoc & { _id: Types.ObjectId; createdAt: Date };

function toEntry(doc: StoredEntry): AuditEntry {
  return {
    id: doc._id.toHexString(),
    projectId: doc.projectId ? doc.projectId.toHexString() : null,
    actorType: doc.actorType,
    actorId: doc.actorId,
    action: doc.action,
    entityType: doc.entityType,
    entityId: doc.entityId,
    before: (doc.before as Snapshot | null | undefined) ?? null,
    after: (doc.after as Snapshot | null | undefined) ?? null,
    requestId: doc.requestId,
    createdAt: doc.createdAt,
  };
}

export function createMongoAuditRepository(): AuditRepository {
  return {
    async append(entry) {
      const doc = await AuditLogModel.create(entry);
      return toEntry(doc.toObject());
    },
    async listByProject(projectId, { skip, limit }) {
      const filter = { projectId };
      const [docs, total] = await Promise.all([
        AuditLogModel.find(filter)
          .sort({ createdAt: -1, _id: -1 })
          .skip(skip)
          .limit(limit)
          .lean<StoredEntry[]>(),
        AuditLogModel.countDocuments(filter),
      ]);
      return { items: docs.map(toEntry), limit, total };
    },
  };
}
