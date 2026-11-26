import mongoose from 'mongoose';
import { afterAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { disconnectDb } from '../src/db.js';
import { ensureIndexes } from '../src/indexes.js';
import { createLogger } from '../src/logger.js';
import { AuditLogModel } from '../src/modules/audit/audit.model.js';
import {
  CandidatePairModel,
  CandidateSummaryModel,
} from '../src/modules/candidates/candidate.model.js';
import {
  ClusterModel,
  ClusterSummaryModel,
  GoldenRecordModel,
} from '../src/modules/clusters/cluster.model.js';
import { LlmCallModel } from '../src/modules/dashboard/llm-call.model.js';
import { ExportModel } from '../src/modules/exports/export.model.js';
import { KnowledgeSummaryModel } from '../src/modules/knowledge/knowledge.model.js';
import type { ExportRecord } from '../src/modules/exports/export.types.js';
import { QualityRunModel } from '../src/modules/quality/quality.model.js';
import type { QualityRun } from '../src/modules/quality/quality.types.js';
import type { SqlVersion } from '../src/modules/sql/sql.types.js';
import { SqlVersionModel } from '../src/modules/sql/sql.model.js';
import { JobModel } from '../src/modules/jobs/job.model.js';
import { PairScoreModel, ScoreSummaryModel } from '../src/modules/scores/score.model.js';
import type { PairScore } from '../src/modules/scores/score.types.js';
import { RefreshTokenModel } from '../src/modules/auth/refresh-token.model.js';
import {
  MappingDecisionModel,
  MappingSuggestionModel,
} from '../src/modules/mappings/mapping.model.js';
import { ColumnProfileModel } from '../src/modules/sources/column-profile.model.js';
import { TargetSchemaModel } from '../src/modules/target-schema/target-schema.model.js';
import { SourceModel } from '../src/modules/sources/source.model.js';
import { StagedRecordModel } from '../src/modules/staged/staged.model.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { createMongoRepositories } from '../src/repositories.js';

import { defineApiSuite } from './support/api-suite.js';
import { defineCandidatesSuite } from './support/candidates-suite.js';
import { defineClustersSuite } from './support/clusters-suite.js';
import { defineDashboardSuite } from './support/dashboard-suite.js';
import { defineExportsSuite } from './support/exports-suite.js';
import { defineQualitySuite } from './support/quality-suite.js';
import { defineSqlSuite } from './support/sql-suite.js';
import { defineScoresSuite } from './support/scores-suite.js';
import { defineJobsSuite } from './support/jobs-suite.js';
import { defineKnowledgeSuite } from './support/knowledge-suite.js';
import { defineAssistantSuite } from './support/assistant-suite.js';
import { defineRetentionSuite } from './support/retention-suite.js';
import { defineMappingsSuite, suggested } from './support/mappings-suite.js';
import { columnProfile, defineProfilesSuite } from './support/profiles-suite.js';
import { defineSourcesSuite } from './support/sources-suite.js';
import { defineStagedSuite } from './support/staged-suite.js';
import type {
  CandidateWrite,
  ClusterWrite,
  ScoreWrite,
  StagedWrite,
  SuggestionWrite,
} from './support/memory-repositories.js';
import { clearDb, connectTestDb } from './support/mongo.js';

const available = await connectTestDb();

/** A score as the scoring job writes it: no AI fields at all. */
function withoutAiFields(score: Omit<PairScore, 'aiStatus'>) {
  const {
    aiDecision: _decision,
    aiConfidence: _confidence,
    aiReason: _reason,
    aiModel: _model,
    aiPromptVersion: _version,
    reviewedAt: _reviewedAt,
    suggestedBand: _suggested,
    ...scored
  } = score;
  return scored;
}

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

  const mongoMappings = {
    ...mongoHarness,
    async markProfiled(_repos: unknown, _projectId: string, sourceId: string) {
      await SourceModel.updateOne({ _id: sourceId }, { $set: { status: 'profiled' } });
    },
    async workerSuggest(_repos: unknown, { projectId, sourceId, suggestions }: SuggestionWrite) {
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
  };
  defineMappingsSuite('MongoDB repositories', mongoMappings);
  const mongoStaged = {
    ...mongoMappings,
    async workerStage(_repos: unknown, { projectId, sourceId, runId, rows, source }: StagedWrite) {
      // What apps/ai-service/app/standardise/store.py writes (then drops the older runs).
      const jobId = new mongoose.Types.ObjectId();
      await StagedRecordModel.insertMany(
        rows.map(({ id, ...row }) => ({
          ...(id ? { _id: id } : {}),
          ...row,
          projectId,
          sourceId,
          jobId,
          runId,
          hasIssues: row.issues.length > 0,
          createdAt: new Date(),
        })),
      );
      const standardisation = source.standardisation && { ...source.standardisation, jobId };
      await SourceModel.updateOne({ _id: sourceId }, { $set: { ...source, standardisation } });
      await StagedRecordModel.deleteMany({ projectId, sourceId, runId: { $ne: runId } });
    },
  };
  defineStagedSuite('MongoDB repositories', mongoStaged);
  const mongoCandidates = {
    ...mongoStaged,
    async workerCandidates(_repos: unknown, { projectId, pairs, summary }: CandidateWrite) {
      // What apps/ai-service/app/matching/store.py writes.
      const jobId = summary.jobId;
      await CandidatePairModel.insertMany(
        pairs.map((pair) => ({
          ...pair,
          projectId,
          jobId,
          runId: summary.runId,
          createdAt: new Date(),
        })),
      );
      await CandidateSummaryModel.replaceOne(
        { projectId },
        { ...summary, projectId },
        { upsert: true },
      );
    },
  };
  defineCandidatesSuite('MongoDB repositories', mongoCandidates);
  const mongoScores = {
    ...mongoCandidates,
    async workerScores(_repos: unknown, { projectId, scores, summary }: ScoreWrite) {
      // What apps/ai-service/app/matching/scoring_store.py writes (then drops the older runs).
      const { jobId, runId, candidatesRunId } = summary;
      await PairScoreModel.insertMany(
        // The scoring job writes no AI fields; only pair_review adds them to maybe pairs.
        scores.map(({ aiStatus, ...score }) => ({
          ...(aiStatus ? { ...score, aiStatus } : withoutAiFields(score)),
          projectId,
          jobId,
          runId,
          candidatesRunId,
          createdAt: new Date(),
        })),
      );
      const { aiReview, ...scored } = summary;
      await ScoreSummaryModel.replaceOne(
        { projectId },
        { ...scored, ...(aiReview ? { aiReview } : {}), projectId },
        { upsert: true },
      );
      await PairScoreModel.deleteMany({ projectId, runId: { $ne: runId } });
    },
  };
  defineScoresSuite('MongoDB repositories', mongoScores);
  const mongoClusters = {
    ...mongoScores,
    async workerClusters(_repos: unknown, { projectId, clusters, golden, summary }: ClusterWrite) {
      // What apps/ai-service/app/matching/cluster_store.py writes (then drops the older runs).
      const { jobId, runId } = summary;
      const oid = (id: string) => new mongoose.Types.ObjectId(id);
      const common = { projectId, jobId, runId, createdAt: new Date() };
      await ClusterModel.insertMany(
        clusters.map((c) => ({
          ...c,
          ...common,
          memberRecordIds: c.memberRecordIds.map(oid),
          links: c.links.map((l) => ({ ...l, recordA: oid(l.recordA), recordB: oid(l.recordB) })),
        })),
      );
      await GoldenRecordModel.insertMany(
        golden.map((g) => ({
          ...g,
          ...common,
          // ObjectIds inside the Mixed provenance, as pymongo stores them.
          provenance: Object.fromEntries(
            Object.entries(g.provenance).map(([field, p]) => [
              field,
              {
                ...p,
                recordId: p.recordId ? oid(p.recordId) : null,
                alternatives: p.alternatives.map((a) => ({
                  ...a,
                  recordIds: a.recordIds.map(oid),
                })),
              },
            ]),
          ),
        })),
      );
      await ClusterSummaryModel.replaceOne(
        { projectId },
        { ...summary, projectId },
        { upsert: true },
      );
      await ClusterModel.deleteMany({ projectId, runId: { $ne: runId } });
      await GoldenRecordModel.deleteMany({ projectId, runId: { $ne: runId } });
    },
  };
  defineClustersSuite('MongoDB repositories', mongoClusters);
  const oid = (value: string) => new mongoose.Types.ObjectId(value);
  const optional = (value: string | null) => (value ? oid(value) : null);
  async function workerExport(_repos: unknown, { id, ...record }: ExportRecord) {
    // What apps/ai-service/app/export/store.py writes: _id = the job id.
    await ExportModel.collection.insertOne({
      ...record,
      _id: oid(id),
      projectId: oid(record.projectId),
      jobId: oid(record.jobId),
      createdBy: optional(record.createdBy),
    });
  }
  defineExportsSuite('MongoDB repositories', { ...mongoClusters, workerExport });

  async function workerSqlVersion(_repos: unknown, { id, ...version }: SqlVersion) {
    // What apps/ai-service/app/sql/store.py writes: _id = the sql_draft job id.
    await SqlVersionModel.collection.insertOne({
      ...version,
      _id: oid(id),
      projectId: oid(version.projectId),
      jobId: oid(version.jobId),
      createdBy: optional(version.createdBy),
      approvedBy: optional(version.approvedBy),
      rejectedBy: optional(version.rejectedBy),
    });
  }
  defineSqlSuite('MongoDB repositories', { ...mongoClusters, workerSqlVersion });
  async function workerQualityRun(_repos: unknown, { id, ...run }: QualityRun) {
    // What apps/ai-service/app/quality/store.py writes: _id = the quality job id.
    await QualityRunModel.collection.insertOne({
      ...run,
      _id: oid(id),
      projectId: oid(run.projectId),
      jobId: oid(run.jobId),
      source: { ...run.source, versionId: optional(run.source.versionId) },
      createdBy: optional(run.createdBy),
    });
  }
  defineQualitySuite('MongoDB repositories', {
    ...mongoClusters,
    workerSqlVersion,
    workerQualityRun,
  });
  defineRetentionSuite('MongoDB repositories', {
    ...mongoClusters,
    workerExport,
    workerQualityRun,
  });
  defineDashboardSuite('MongoDB repositories', {
    ...mongoClusters,
    workerSqlVersion,
    workerQualityRun,
    workerExport,
    async workerUpdate(_repos, jobId, patch) {
      await JobModel.updateOne({ _id: jobId }, { $set: patch });
    },
    async workerLlmCall(_repos, call) {
      // What apps/ai-service/app/llm/cost.py (LLMCallRecord.model_dump()) appends.
      await LlmCallModel.collection.insertOne({
        task: call.task,
        provider: call.model === 'mock' ? 'mock' : 'gemini',
        model: call.model,
        prompt_version: 'v1',
        input_tokens: call.inputTokens,
        output_tokens: call.outputTokens,
        cost_inr: call.costInr,
        latency_ms: call.latencyMs,
        cache_hit: call.cacheHit,
        attempts: 1,
        outcome: call.outcome,
        error_type: call.errorType,
        error_code: call.errorCode,
        error_status: call.errorStatus,
        error_detail: call.outcome === 'error' ? 'The model is overloaded.' : null,
        schema_fallback: call.schemaFallback,
        project_id: call.projectId,
        request_id: null,
        created_at: call.createdAt,
      });
    },
  });
  defineKnowledgeSuite('MongoDB repositories', {
    ...mongoHarness,
    async workerKnowledgeSummary(_repos, summary) {
      // What apps/ai-service/app/worker/handlers/knowledge.py stores.
      await KnowledgeSummaryModel.collection.insertOne({
        ...summary,
        projectId: new mongoose.Types.ObjectId(summary.projectId),
        jobId: new mongoose.Types.ObjectId(summary.jobId),
        removed: 0,
      });
    },
  });
  defineAssistantSuite('MongoDB repositories', {
    ...mongoHarness,
    async workerKnowledgeSummary(_repos, summary) {
      await KnowledgeSummaryModel.collection.insertOne({
        ...summary,
        projectId: new mongoose.Types.ObjectId(summary.projectId),
        jobId: new mongoose.Types.ObjectId(summary.jobId),
      });
    },
    async workerLlmCall(_repos, call) {
      // What apps/ai-service/app/llm/cost.py appends.
      await LlmCallModel.collection.insertOne({
        task: call.task,
        provider: 'mock',
        model: call.model,
        prompt_version: 'assistant.v1',
        input_tokens: call.inputTokens,
        output_tokens: call.outputTokens,
        cost_inr: call.costInr,
        latency_ms: call.latencyMs,
        cache_hit: call.cacheHit,
        attempts: 1,
        outcome: call.outcome,
        error_type: null,
        error_code: null,
        error_status: null,
        error_detail: null,
        schema_fallback: false,
        project_id: call.projectId,
        request_id: null,
        created_at: call.createdAt,
      });
    },
  });

  describe('schema guarantees', () => {
    it('keeps TTL indexes for finished jobs, LLM calls and idle assistant conversations (G3-11)', async () => {
      const config = loadConfig({ NODE_ENV: 'test', JOB_RETENTION_DAYS: '7' });
      await ensureIndexes(config, createLogger(config));
      const ttl = async (collection: string) =>
        (await mongoose.connection.collection(collection).indexes()).filter(
          (index) => index.expireAfterSeconds !== undefined,
        );

      // A changed setting updates the expiry in place.
      expect(await ttl('jobs')).toEqual([
        expect.objectContaining({ key: { finishedAt: 1 }, expireAfterSeconds: 7 * 86_400 }),
      ]);
      expect(await ttl('llm_calls')).toEqual([
        expect.objectContaining({ key: { created_at: 1 }, expireAfterSeconds: 30 * 86_400 }),
      ]);
      expect(await ttl('assistant_conversations')).toEqual([
        expect.objectContaining({ key: { updatedAt: 1 }, expireAfterSeconds: 30 * 86_400 }),
      ]);
      const defaults = loadConfig({ NODE_ENV: 'test' });
      await ensureIndexes(defaults, createLogger(defaults));
      expect(await ttl('jobs')).toEqual([
        expect.objectContaining({ key: { finishedAt: 1 }, expireAfterSeconds: 30 * 86_400 }),
      ]);
    });

    it('allows one queued job per lock and one approved SQL version per project (G3-12, G3-13)', async () => {
      const jobIndexes = await JobModel.collection.indexes();
      expect(jobIndexes).toContainEqual(
        expect.objectContaining({
          name: 'one_queued_job_per_lock',
          key: { projectId: 1, type: 1, lockKey: 1 },
          unique: true,
          partialFilterExpression: { status: 'queued', lockKey: { $exists: true } },
        }),
      );
      const sqlIndexes = await SqlVersionModel.collection.indexes();
      expect(sqlIndexes).toContainEqual(
        expect.objectContaining({
          name: 'one_approved_version_per_project',
          key: { projectId: 1 },
          unique: true,
          partialFilterExpression: { status: 'approved' },
        }),
      );
    });

    it('supersedes older duplicate approvals before building the SQL index on old data', async () => {
      await clearDb();
      await SqlVersionModel.collection.dropIndex('one_approved_version_per_project');
      const projectId = new mongoose.Types.ObjectId();
      const base = { projectId, status: 'approved', sql: 'select 1', testsPassed: true };
      await SqlVersionModel.collection.insertMany([
        { ...base, version: 1 },
        { ...base, version: 2 },
      ]);
      const config = loadConfig({ NODE_ENV: 'test' });

      await ensureIndexes(config, createLogger(config));

      const docs = await SqlVersionModel.find({ projectId }).sort({ version: 1 }).lean();
      expect(docs.map((d) => d.status)).toEqual(['superseded', 'approved']);
      expect((await SqlVersionModel.collection.indexes()).map((index) => index.name)).toContain(
        'one_approved_version_per_project',
      );
    });

    it('deletes rows of finished runs that are not current, keeping current and active runs', async () => {
      await clearDb();
      const projectId = new mongoose.Types.ObjectId();
      const user = new mongoose.Types.ObjectId();
      const job = async (status: string) =>
        (
          await JobModel.collection.insertOne({
            projectId,
            type: 'scoring',
            status,
            createdBy: user,
            queuedAt: new Date(),
          })
        ).insertedId.toHexString();
      const [current, crashed, running] = [
        `${await job('succeeded')}:1`,
        `${await job('failed')}:1`,
        `${await job('running')}:2`,
      ];
      await ScoreSummaryModel.collection.insertOne({ projectId, runId: current });
      for (const runId of [
        current,
        crashed,
        running,
        `${new mongoose.Types.ObjectId().toHexString()}:1`,
      ]) {
        await PairScoreModel.collection.insertOne({ projectId, runId, position: 1 });
      }

      const deleted = await createMongoRepositories().retention.deleteOrphanRuns();

      expect(deleted).toBe(2); // the crashed run and one whose job is long gone
      const left = await PairScoreModel.collection.distinct('runId');
      expect(left.sort()).toEqual([current, running].sort());
    });

    it('reports collection sizes for the admin storage view', async () => {
      await clearDb();
      await JobModel.collection.insertOne({ projectId: new mongoose.Types.ObjectId() });
      const usage = await createMongoRepositories().retention.collectionUsage();
      const jobs = usage.find((c) => c.name === 'jobs');
      expect(jobs?.documents).toBe(1);
      // A self-hosted MongoDB reports byte sizes ($collStats); a shared tier may not.
      expect(jobs?.storageBytes === null || (jobs?.storageBytes ?? 0) > 0).toBe(true);
    });

    it('keeps one staged row per run and row number', async () => {
      await clearDb();
      await StagedRecordModel.syncIndexes();
      const doc = {
        projectId: new mongoose.Types.ObjectId(),
        sourceId: new mongoose.Types.ObjectId(),
        jobId: new mongoose.Types.ObjectId(),
        runId: 'r:1',
        rowNumber: 1,
        fields: { phone: '+919820012345' },
        hasIssues: false,
        createdAt: new Date(),
      };
      await StagedRecordModel.create(doc);
      await StagedRecordModel.create({ ...doc, runId: 'r:2' });

      await expect(StagedRecordModel.create(doc)).rejects.toThrow(/duplicate key/);
      const indexes = await StagedRecordModel.collection.indexes();
      expect(indexes).toContainEqual(
        expect.objectContaining({
          key: { projectId: 1, sourceId: 1, runId: 1, rowNumber: 1 },
          unique: true,
        }),
      );
    });

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

    it('lets only one caller claim the bootstrap admin slot', async () => {
      await clearDb();
      const repos = createMongoRepositories();
      const claims = await Promise.all([1, 2, 3].map(() => repos.users.claimBootstrapAdmin()));

      expect(claims.filter(Boolean)).toHaveLength(1);
    });

    it('changes a user role and returns the updated user', async () => {
      await clearDb();
      const repos = createMongoRepositories();
      const user = await repos.users.create({
        email: 'boss@example.com',
        name: 'Boss',
        passwordHash: 'x',
        role: 'data_engineer',
      });

      expect((await repos.users.setRole(user.id, 'admin'))?.role).toBe('admin');
      expect((await repos.users.findById(user.id))?.role).toBe('admin');
      expect(await repos.users.setRole('64b000000000000000000999', 'admin')).toBeNull();
    });
  });
});
