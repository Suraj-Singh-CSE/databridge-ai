import type { Types } from 'mongoose';

import { RefreshTokenModel, type RefreshTokenDoc } from './refresh-token.model.js';
import type { RefreshTokenRecord, RefreshTokenRepository } from './refresh-token.types.js';

type StoredToken = RefreshTokenDoc & { _id: Types.ObjectId; createdAt: Date };

function toRecord(doc: StoredToken): RefreshTokenRecord {
  return {
    id: doc._id.toHexString(),
    userId: doc.userId.toHexString(),
    tokenHash: doc.tokenHash,
    familyId: doc.familyId,
    expiresAt: doc.expiresAt,
    revokedAt: doc.revokedAt ?? null,
    replacedBy: doc.replacedBy ? doc.replacedBy.toHexString() : null,
    reuseDetectedAt: doc.reuseDetectedAt ?? null,
    createdAt: doc.createdAt,
  };
}

export function createMongoRefreshTokenRepository(): RefreshTokenRepository {
  return {
    async create(input) {
      const doc = await RefreshTokenModel.create(input);
      return toRecord(doc.toObject());
    },
    async findByHash(tokenHash) {
      const doc = await RefreshTokenModel.findOne({ tokenHash }).lean<StoredToken>();
      return doc ? toRecord(doc) : null;
    },
    async revoke(id, at) {
      const result = await RefreshTokenModel.updateOne(
        { _id: id, revokedAt: null },
        { $set: { revokedAt: at } },
      );
      return result.modifiedCount === 1;
    },
    async setReplacedBy(id, replacedBy) {
      await RefreshTokenModel.updateOne({ _id: id }, { $set: { replacedBy } });
    },
    async revokeFamily(familyId, at) {
      await RefreshTokenModel.updateMany({ familyId }, { $set: { reuseDetectedAt: at } });
      await RefreshTokenModel.updateMany(
        { familyId, revokedAt: null },
        { $set: { revokedAt: at } },
      );
    },
    async isFamilyCompromised(familyId) {
      const found = await RefreshTokenModel.exists({ familyId, reuseDetectedAt: { $ne: null } });
      return found !== null;
    },
  };
}
