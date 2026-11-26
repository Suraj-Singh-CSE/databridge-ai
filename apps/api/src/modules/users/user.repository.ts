import type { Types } from 'mongoose';

import { DuplicateKeyError } from '../../errors.js';
import { isDuplicateKeyError } from '../../mongo-errors.js';

import { AppMetaModel, UserModel, type UserDoc } from './user.model.js';
import type { User, UserRepository } from './user.types.js';

type StoredUser = UserDoc & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

// A new key (Gate 2 used "first-admin" for "first registrant is admin"), so an existing
// deployment's old claim does not block the configured bootstrap admin (ADR 0027).
const BOOTSTRAP_ADMIN_KEY = 'bootstrap-admin';

function toUser(doc: StoredUser): User {
  return {
    id: doc._id.toHexString(),
    email: doc.email,
    name: doc.name,
    role: doc.role,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export function createMongoUserRepository(): UserRepository {
  return {
    async create(input) {
      try {
        const doc = await UserModel.create(input);
        return toUser(doc.toObject());
      } catch (error) {
        if (isDuplicateKeyError(error)) throw new DuplicateKeyError('email already registered');
        throw error;
      }
    },
    async findById(id) {
      const doc = await UserModel.findById(id).lean<StoredUser>();
      return doc ? toUser(doc) : null;
    },
    async findByIds(ids) {
      if (ids.length === 0) return [];
      const docs = await UserModel.find({ _id: { $in: ids } }).lean<StoredUser[]>();
      return docs.map(toUser);
    },
    async findByEmail(email) {
      const doc = await UserModel.findOne({ email }).lean<StoredUser>();
      return doc ? toUser(doc) : null;
    },
    async findCredentialsByEmail(email) {
      const doc = await UserModel.findOne({ email }).lean<StoredUser>();
      return doc ? { user: toUser(doc), passwordHash: doc.passwordHash } : null;
    },
    async setRole(id, role) {
      const doc = await UserModel.findByIdAndUpdate(
        id,
        { $set: { role } },
        { returnDocument: 'after', runValidators: true },
      ).lean<StoredUser>();
      return doc ? toUser(doc) : null;
    },
    async claimBootstrapAdmin() {
      try {
        await AppMetaModel.create({ _id: BOOTSTRAP_ADMIN_KEY, claimedAt: new Date() });
        return true;
      } catch (error) {
        if (isDuplicateKeyError(error)) return false;
        throw error;
      }
    },
  };
}
