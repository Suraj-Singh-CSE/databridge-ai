import mongoose from 'mongoose';
import { afterAll, describe, expect, it } from 'vitest';

import { disconnectDb } from '../src/db.js';
import { AuditLogModel } from '../src/modules/audit/audit.model.js';
import { RefreshTokenModel } from '../src/modules/auth/refresh-token.model.js';
import { SourceModel } from '../src/modules/sources/source.model.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { createMongoRepositories } from '../src/repositories.js';

import { defineApiSuite } from './support/api-suite.js';
import { defineSourcesSuite } from './support/sources-suite.js';
import { clearDb, connectTestDb } from './support/mongo.js';

const available = await connectTestDb();

afterAll(async () => {
  if (available) await disconnectDb();
});

const mongoHarness = {
  async setup() {
    await clearDb();
    return createMongoRepositories();
  },
};

describe.skipIf(!available)('MongoDB', () => {
  defineApiSuite('MongoDB repositories', mongoHarness);
  defineSourcesSuite('MongoDB repositories', mongoHarness);

  describe('schema guarantees', () => {
    it('enforces unique, lowercased emails at the index level', async () => {
      await clearDb();
      const repos = createMongoRepositories();
      const input = { name: 'A', passwordHash: 'x', role: 'viewer' } as const;
      await repos.users.create({ ...input, email: 'Unique@Example.com' });

      await expect(repos.users.create({ ...input, email: 'unique@example.com' })).rejects.toThrow(
        'email already registered',
      );
      expect((await UserModel.findOne().lean())?.email).toBe('unique@example.com');
    });

    it('never serialises the password hash', async () => {
      await clearDb();
      const doc = await UserModel.create({
        email: 'json@example.com',
        name: 'J',
        passwordHash: 'secret-hash',
        role: 'viewer',
      });

      expect(JSON.stringify(doc)).not.toContain('secret-hash');
      expect(doc.toJSON()).toMatchObject({ id: doc._id.toHexString(), email: 'json@example.com' });
    });

    it('expires refresh tokens with a TTL index on expiresAt', async () => {
      const indexes = await RefreshTokenModel.collection.indexes();

      expect(indexes).toContainEqual(
        expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 0 }),
      );
    });

    it('refuses to update or delete audit entries', async () => {
      await clearDb();
      const repos = createMongoRepositories();
      const entry = await repos.audit.append({
        projectId: new mongoose.Types.ObjectId().toHexString(),
        actorType: 'ai',
        actorId: 'mapping-agent',
        action: 'mapping.propose',
        entityType: 'mapping',
        entityId: 'm1',
        before: null,
        after: { column: 'email' },
        requestId: 'r1',
      });

      await expect(AuditLogModel.updateOne({ _id: entry.id }, { action: 'x' })).rejects.toThrow(
        'append-only',
      );
      await expect(AuditLogModel.deleteMany({})).rejects.toThrow('append-only');
      expect(await AuditLogModel.countDocuments()).toBe(1);
    });

    it('indexes sources by project and creation time, unique by sha256 per project', async () => {
      const indexes = await SourceModel.collection.indexes();

      expect(indexes).toContainEqual(
        expect.objectContaining({ key: { projectId: 1, createdAt: -1 } }),
      );
      expect(indexes).toContainEqual(
        expect.objectContaining({ key: { projectId: 1, sha256: 1 }, unique: true }),
      );
    });

    it('lets only one caller claim the first admin slot', async () => {
      await clearDb();
      const repos = createMongoRepositories();
      const claims = await Promise.all([1, 2, 3].map(() => repos.users.claimFirstAdmin()));

      expect(claims.filter(Boolean)).toHaveLength(1);
    });
  });
});
