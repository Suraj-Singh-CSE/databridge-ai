import type { Types } from 'mongoose';

import { DuplicateKeyError } from '../../errors.js';
import { isDuplicateKeyError } from '../../mongo-errors.js';

import { AppMetaModel, UserModel, type UserDoc } from './user.model.js';
import type { User, UserRepository } from './user.types.js';

type StoredUser = UserDoc & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

const FIRST_ADMIN_KEY = 'first-admin';

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
    async findByEmail(email) {
      const doc = await UserModel.findOne({ email }).lean<StoredUser>();
      return doc ? toUser(doc) : null;
    },
    async findCredentialsByEmail(email) {
      const doc = await UserModel.findOne({ email }).lean<StoredUser>();
      return doc ? { user: toUser(doc), passwordHash: doc.passwordHash } : null;
    },
    count() {
      return UserModel.countDocuments();
    },
    async claimFirstAdmin() {
      try {
        await AppMetaModel.create({ _id: FIRST_ADMIN_KEY, claimedAt: new Date() });
        return true;
      } catch (error) {
        if (isDuplicateKeyError(error)) return false;
        throw error;
      }
    },
  };
}
