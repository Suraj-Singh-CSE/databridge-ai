import mongoose from 'mongoose';
import { afterAll, describe, expect, it } from 'vitest';

import { disconnectDb } from '../src/db.js';
import { AuditLogModel } from '../src/modules/audit/audit.model.js';
import { JobModel } from '../src/modules/jobs/job.model.js';
import { RefreshTokenModel } from '../src/modules/auth/refresh-token.model.js';
import {
  MappingDecisionModel,
  MappingSuggestionModel,
} from '../src/modules/mappings/mapping.model.js';
import { ColumnProfileModel } from '../src/modules/sources/column-profile.model.js';
import { TargetSchemaModel } from '../src/modules/target-schema/target-schema.model.js';
import { SourceModel } from '../src/modules/sources/source.model.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { createMongoRepositories } from '../src/repositories.js';

import { defineApiSuite } from './support/api-suite.js';
import { defineJobsSuite } from './support/jobs-suite.js';
import { defineMappingsSuite, suggested } from './support/mappings-suite.js';
import { columnProfile, defineProfilesSuite } from './support/profiles-suite.js';
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
  defineProfilesSuite('MongoDB repositories', {
    ...mongoHarness,
    async workerProfile(_repos, { projectId, sourceId, columns, source }) {
      // What apps/ai-service/app/profiling/store.py writes.
      const jobId = new mongoose.Types.ObjectId();
      const runId = `${jobId.toHexString()}:1`;
      await ColumnProfileModel.insertMany(
        columns.map((column) => ({ ...column, projectId, sourceId, jobId, runId })),
      );
      await SourceModel.updateOne({ _id: sourceId }, { $set: { ...source, profileRunId: runId } });
    },
  });
  defineJobsSuite('MongoDB repositories', {
    ...mongoHarness,
    async workerUpdate(_repos, jobId, patch) {
      await JobModel.updateOne({ _id: jobId }, { $set: patch });
    },
  });

  defineMappingsSuite('MongoDB repositories', {
    ...mongoHarness,
    async markProfiled(_repos, _projectId, sourceId) {
      await SourceModel.updateOne({ _id: sourceId }, { $set: { status: 'profiled' } });
    },
    async workerSuggest(_repos, { projectId, sourceId, suggestions }) {
      // What apps/ai-service/app/mapping/store.py writes.
      await MappingSuggestionModel.insertMany(
        suggestions.map(({ column, position, suggestion, run }) => ({
          projectId,
          sourceId,
          column,
          position,
          jobId: run.jobId,
          runId: run.runId,
          schemaVersion: run.schemaVersion,
          mappingVersion: 1,
          method: run.method,
          model: run.model,
          suggestion,
          createdAt: run.createdAt,
        })),
      );
    },
  });

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

    it('keeps one profile per column of a source', async () => {
      await clearDb();
      await ColumnProfileModel.syncIndexes();
      const ids = {
        projectId: new mongoose.Types.ObjectId(),
        sourceId: new mongoose.Types.ObjectId(),
        jobId: new mongoose.Types.ObjectId(),
        runId: 'r:1',
      };
      await ColumnProfileModel.create({ ...columnProfile('email', 0), ...ids });

      await expect(
        ColumnProfileModel.create({ ...columnProfile('email', 3), ...ids }),
      ).rejects.toThrow(/duplicate key/);
      const indexes = await ColumnProfileModel.collection.indexes();
      expect(indexes).toContainEqual(
        expect.objectContaining({ key: { projectId: 1, sourceId: 1, column: 1 }, unique: true }),
      );
    });

    it('keeps one target schema per project and one suggestion and decision per column', async () => {
      await clearDb();
      await Promise.all(
        [TargetSchemaModel, MappingSuggestionModel, MappingDecisionModel].map((m) =>
          m.syncIndexes(),
        ),
      );
      const projectId = new mongoose.Types.ObjectId();
      const sourceId = new mongoose.Types.ObjectId();
      await TargetSchemaModel.create({ projectId, name: 'A', version: 1, fields: [] });
      await expect(
        TargetSchemaModel.create({ projectId, name: 'B', version: 1, fields: [] }),
      ).rejects.toThrow(/duplicate key/);

      const { column, position, suggestion, run } = suggested('email', 0, 'email');
      const doc = {
        projectId,
        sourceId,
        column,
        position,
        jobId: run.jobId,
        runId: run.runId,
        schemaVersion: 1,
        mappingVersion: 1,
        method: run.method,
        model: run.model,
        suggestion,
        createdAt: run.createdAt,
      };
      await MappingSuggestionModel.create(doc);
      await expect(MappingSuggestionModel.create(doc)).rejects.toThrow(/duplicate key/);
      for (const model of [MappingSuggestionModel, MappingDecisionModel]) {
        expect(await model.collection.indexes()).toContainEqual(
          expect.objectContaining({ key: { projectId: 1, sourceId: 1, column: 1 }, unique: true }),
        );
      }
    });

    it('creates the default target schema once even when asked twice at the same moment', async () => {
      await clearDb();
      await TargetSchemaModel.syncIndexes();
      const repos = createMongoRepositories();
      const projectId = new mongoose.Types.ObjectId().toHexString();
      const input = { name: 'Customer 360', fields: [] };

      const [a, b] = await Promise.all([
        repos.targetSchemas.createIfMissing(projectId, input),
        repos.targetSchemas.createIfMissing(projectId, input),
      ]);

      expect([a.version, b.version]).toEqual([1, 1]);
      expect(await TargetSchemaModel.countDocuments({ projectId })).toBe(1);
    });

    it('indexes jobs by project and creation time', async () => {
      const indexes = await JobModel.collection.indexes();

      expect(indexes).toContainEqual(
        expect.objectContaining({ key: { projectId: 1, createdAt: -1 } }),
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
