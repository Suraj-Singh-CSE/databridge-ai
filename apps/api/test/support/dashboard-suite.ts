import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { BENCHMARKS } from '../../src/modules/dashboard/benchmarks.js';
import type { Dashboard } from '../../src/modules/dashboard/dashboard.service.js';
import type { LlmCall } from '../../src/modules/dashboard/dashboard.types.js';
import type { Repositories } from '../../src/repositories.js';

import { buildTestApp, fastPasswords } from './build-app.js';
import { FakeAiService } from './fakes.js';
import type { ExportsHarness } from './exports-suite.js';
import type { JobsHarness } from './jobs-suite.js';
import { suggested } from './mappings-suite.js';
import { newId, prepareClusters, type PipelineContext } from './pipeline-fixtures.js';
import type { QualityHarness } from './quality-suite.js';

export interface DashboardHarness
  extends QualityHarness, ExportsHarness, Pick<JobsHarness, 'workerUpdate'> {
  /** Appends a call record as the ai-service LLM gateway does. */
  workerLlmCall(repos: Repositories, call: LlmCall): Promise<void>;
}

interface Session {
  id: string;
  token: string;
}

type Role = 'viewer' | 'data_steward' | 'data_engineer';

const PASSWORD = 'correct horse battery';
const bearer = (s: Session) => ({ Authorization: `Bearer ${s.token}` });
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Values the fixtures put in staged and golden records: they must never reach the dashboard. */
const RECORD_VALUES = ['Asha Rao', '+919820012345', '9820012345'];

/** GET /projects/:projectId/dashboard (memory and MongoDB). */
export function defineDashboardSuite(label: string, harness: DashboardHarness): void {
  describe(`Project dashboard API (${label})`, () => {
    let repos: Repositories;
    let app: Express;
    let owner: Session;
    let projectId: string;

    async function register(email: string): Promise<Session> {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ email, name: 'User', password: PASSWORD })
        .expect(201);
      const body = res.body as { data: { user: { id: string }; accessToken: string } };
      return { id: body.data.user.id, token: body.data.accessToken };
    }

    async function memberWith(role: Role): Promise<Session> {
      const email = `${role}-${Math.random().toString(36).slice(2)}@example.com`;
      await repos.users.create({
        email,
        name: role,
        role: 'data_engineer',
        passwordHash: await fastPasswords.hash(PASSWORD),
      });
      const login = await request(app)
        .post('/api/v1/auth/login')
        .send({ email, password: PASSWORD })
        .expect(200);
      await request(app)
        .post(`/api/v1/projects/${projectId}/members`)
        .set(bearer(owner))
        .send({ email, role })
        .expect(201);
      const body = login.body as { data: { user: { id: string }; accessToken: string } };
      return { id: body.data.user.id, token: body.data.accessToken };
    }

    const url = (query = '', project = projectId) =>
      `/api/v1/projects/${project}/dashboard${query}`;
    // One instant per test: two separate Date.now() calls can be 1 ms apart, which made
    // "approved 1 hour after creation" come out as 3,600,001 ms.
    let seededAt = Date.now();
    const ago = (ms: number) => new Date(seededAt - ms);

    function llmCall(overrides: Partial<LlmCall>): LlmCall {
      return {
        projectId,
        task: 'column_mapping',
        model: 'mock',
        inputTokens: 100,
        outputTokens: 20,
        costInr: 0,
        latencyMs: 200,
        cacheHit: false,
        outcome: 'ok',
        errorType: null,
        errorCode: null,
        errorStatus: null,
        schemaFallback: false,
        createdAt: ago(HOUR),
        ...overrides,
      };
    }

    async function finishedJob(
      type: 'mapping' | 'clustering' | 'quality',
      status: 'succeeded' | 'failed' | 'cancelled',
      durationMs: number,
      code: string | null = null,
    ): Promise<void> {
      const job = await repos.jobs.create({ projectId, type, payload: {}, createdBy: owner.id });
      const startedAt = ago(2 * HOUR);
      await harness.workerUpdate(repos, job.id, {
        status,
        progress: 100,
        startedAt,
        finishedAt: new Date(startedAt.getTime() + durationMs),
        error: code ? { code, message: 'The worker reported a problem.' } : null,
      });
    }

    /** A project that went through every step: mapping, matching, SQL, quality, export. */
    async function seedFullProject(steward: Session): Promise<void> {
      const ctx: PipelineContext = { repos, harness, projectId, ownerId: owner.id };
      const { clusters } = await prepareClusters(ctx);
      const [source] = await repos.sources.listByProject(projectId);
      const sourceId = source?.id ?? '';
      await harness.workerSuggest(repos, {
        projectId,
        sourceId,
        suggestions: [
          suggested('email', 0, 'email'),
          suggested('phone', 1, 'phone'),
          suggested('name', 2, 'full_name'),
        ],
      });
      const mappings = `/api/v1/projects/${projectId}/sources/${sourceId}/mappings`;
      await request(app)
        .patch(`${mappings}/email`)
        .set(bearer(owner))
        .send({ decision: 'accept' })
        .expect(200);
      await request(app)
        .patch(`${mappings}/phone`)
        .set(bearer(steward))
        .send({ decision: 'reject' })
        .expect(200);
      await request(app)
        .post(`/api/v1/projects/${projectId}/clusters/${clusters[0]?.customerId ?? ''}/approve`)
        .set(bearer(steward))
        .send({})
        .expect(200);

      const summary = await repos.clusters.findSummary(projectId);
      const runId = summary?.runId ?? '';
      const versionId = newId();
      await harness.workerSqlVersion(repos, {
        id: versionId,
        projectId,
        jobId: versionId,
        version: 1,
        sql: 'SELECT g."customer_id" FROM golden_records AS g',
        explanation: '',
        assumptions: [],
        method: 'reference',
        model: null,
        promptVersion: null,
        fallbackReason: 'LLM_DISABLED',
        scope: 'approved',
        instructions: null,
        validation: { ok: true, code: null, message: null },
        error: null,
        tests: null,
        testsPassed: true,
        attempts: [],
        usage: null,
        status: 'approved',
        createdBy: owner.id,
        createdAt: ago(3 * HOUR),
        clusteringRunId: runId,
        schemaVersion: 1,
        lastRun: null,
        approvedBy: owner.id,
        approvedAt: ago(2 * HOUR),
        rejectedBy: null,
        rejectedAt: null,
        rejectReason: null,
        supersededAt: null,
      });
      const exportId = newId();
      await harness.workerExport(repos, {
        id: exportId,
        projectId,
        jobId: exportId,
        format: 'csv',
        scope: 'approved',
        includeSources: false,
        rowCount: 1,
        bytes: 64,
        sha256: 'a'.repeat(64),
        fileKey: `projects/${projectId}/exports/${exportId}.csv`,
        clusteringRunId: runId,
        schemaVersion: 1,
        status: 'ready',
        createdBy: owner.id,
        createdAt: ago(HOUR),
      });
      for (const [hoursAgo, status, counts] of [
        [3, 'fail', { pass: 5, warn: 1, fail: 1, skipped: 0 }],
        [1, 'warn', { pass: 6, warn: 1, fail: 0, skipped: 1 }],
      ] as const) {
        const id = newId();
        await harness.workerQualityRun(repos, {
          id,
          projectId,
          jobId: id,
          startedAt: ago(hoursAgo * HOUR),
          finishedAt: ago(hoursAgo * HOUR - 1500),
          source: {
            kind: 'sql_version',
            label: 'Approved SQL version 1',
            versionId,
            version: 1,
            scope: 'approved',
            sqlTestsPassed: true,
            failedChecks: [],
          },
          clusteringRunId: runId,
          schemaVersion: 1,
          rowCount: 3,
          status,
          statusCounts: counts,
          ruleCount: 8,
          results: [
            {
              rule: 'completeness_optional',
              label: 'Optional field filled in',
              field: 'pin_code',
              status: 'warn',
              metric: 66.67,
              unit: 'percent',
              direction: 'min',
              threshold: { warn: 80, fail: 50 },
              message: 'Asha Rao has no PIN code.',
              counts: { rows: 3, filled: 2, empty: 1 },
              exampleIds: ['C3'],
            },
          ],
          config: {},
          createdBy: owner.id,
        });
      }

      await finishedJob('mapping', 'succeeded', 1000);
      await finishedJob('mapping', 'succeeded', 3000);
      await finishedJob('mapping', 'failed', 500, 'LLM_UNAVAILABLE');
      await finishedJob('clustering', 'cancelled', 100);

      for (const call of [
        llmCall({ latencyMs: 100 }),
        llmCall({ latencyMs: 300, schemaFallback: true, model: 'gemini-3.5-flash-lite' }),
        llmCall({ latencyMs: 1, cacheHit: true }),
        llmCall({
          outcome: 'error',
          errorType: 'LLMProviderError',
          errorCode: 503,
          errorStatus: 'UNAVAILABLE',
          outputTokens: 0,
        }),
        llmCall({ task: 'pair_review', latencyMs: 900, createdAt: ago(10 * DAY) }),
        // Outside every range, and another project's call: neither is counted.
        llmCall({ createdAt: ago(100 * DAY) }),
        llmCall({ projectId: newId() }),
      ]) {
        await harness.workerLlmCall(repos, call);
      }
    }

    beforeEach(async () => {
      seededAt = Date.now();
      repos = await harness.setup();
      app = buildTestApp({ repos });
      await register('first-admin@example.com');
      owner = await register('owner@example.com');
      const res = await request(app)
        .post('/api/v1/projects')
        .set(bearer(owner))
        .send({ name: 'Customer 360' })
        .expect(201);
      projectId = (res.body as { data: { project: { id: string } } }).data.project.id;
    });

    it('reports every section of a seeded project with counts only, never record values', async () => {
      const steward = await memberWith('data_steward');
      await seedFullProject(steward);

      const started = performance.now();
      const res = await request(app).get(url()).set(bearer(owner));
      const ms = Math.round(performance.now() - started);
      process.stderr.write(`[dashboard ${label}] seeded project answered in ${ms} ms\n`);

      expect(res.status).toBe(200);
      expect(res.body.error).toBeNull();
      const { data } = res.body as { data: Dashboard };
      expect(data.range).toMatchObject({ key: '30d', days: 30 });

      const p = data.pipeline;
      expect(p.sources).toMatchObject({ count: 1, rowsUploaded: 4 });
      expect(p.sources.byStatus.standardised).toBe(1);
      expect(p.mapping).toEqual({
        sourcesMapped: 1,
        columns: 3,
        decided: 2,
        pending: 1,
        sourcesOnRules: 0,
        outdated: false,
      });
      expect(p.standardise).toEqual({ sources: 1, rows: 4, rowsWithIssues: 0, outdated: false });
      expect(p.candidates).toEqual({ ran: true, pairs: 1, outdated: false });
      expect(p.scores).toEqual({
        ran: true,
        pairs: 1,
        byBand: { match: 1, maybe: 0, non_match: 0 },
        outdated: false,
      });
      expect(p.aiReview).toEqual({ ran: false, pairs: 0, reviewed: 0, unavailable: 0 });
      expect(p.clusters).toEqual({
        ran: true,
        customers: 3,
        multiRecord: 1,
        recordsMerged: 1,
        needsReview: 0,
        approved: 1,
        proposed: 2,
        outdated: false,
      });
      expect(p.sql).toEqual({
        latest: { version: 1, status: 'approved', testsPassed: true, method: 'reference' },
        approvedVersion: 1,
        outdated: false,
      });
      expect(p.exports).toEqual({ count: 1, outdated: false });
      expect(p.quality.latest?.status).toBe('warn');
      expect(p.quality.outdated).toBe(false);
      expect(p.nextStep).toEqual({
        text: 'Approve the mapping for crm_customers',
        step: 'mapping',
      });

      expect(data.quality.runs.map((r: { status: string }) => r.status)).toEqual(['fail', 'warn']);
      expect(data.quality.runs[1]).toMatchObject({ pass: 6, warn: 1, fail: 0 });
      expect(data.quality.latestRules).toEqual([
        {
          rule: 'completeness_optional',
          field: 'pin_code',
          label: 'Optional field filled in',
          status: 'warn',
          metric: 66.67,
          unit: 'percent',
        },
      ]);

      const mapping = data.ai.tasks.find((t) => t.task === 'column_mapping');
      expect(mapping).toEqual({
        task: 'column_mapping',
        calls: 4,
        ok: 3,
        failed: 1,
        failedBy: [
          { status: 'UNAVAILABLE', httpCode: 503, errorType: 'LLMProviderError', count: 1 },
        ],
        cacheHits: 1,
        schemaFallbacks: 1,
        inputTokens: 400,
        outputTokens: 60,
        costInr: 0,
        costLabel: 'free tier',
        latencyMs: { p50: 100, p95: 300, samples: 2 },
        models: ['gemini-3.5-flash-lite', 'mock'],
      });
      expect(data.ai.total).toMatchObject({ calls: 5, ok: 4, failed: 1, inputTokens: 500 });
      expect(data.ai.total.latencyMs).toEqual({ p50: 300, p95: 900, samples: 3 });
      expect(data.ai.fallbacks).toEqual({
        mappingSourcesOnRules: 0,
        sqlReferenceVersions: 1,
        pairReviewUnavailable: 0,
      });
      expect(data.ai.daily).toHaveLength(31);
      const daily = data.ai.daily as { calls: number; tokens: number }[];
      expect(daily.reduce((n, d) => n + d.calls, 0)).toBe(5);
      expect(daily.reduce((n, d) => n + d.tokens, 0)).toBe(580);

      expect(data.review.byType).toMatchObject({
        mapping_accept: 1,
        mapping_reject: 1,
        match_approve: 1,
        sql_approve: 0,
      });
      expect(data.review.total).toBe(3);
      expect(data.review.byRole).toEqual({ owner: 1, data_steward: 2 });
      expect(data.review.medianTimeToDecisionMs.mapping?.samples).toBe(2);
      expect(data.review.medianTimeToDecisionMs.match_approve?.samples).toBe(1);
      expect(data.review.medianTimeToDecisionMs.sql).toEqual({ medianMs: HOUR, samples: 1 });

      const mappingJobs = data.jobs.byType.find((j) => j.type === 'mapping');
      expect(mappingJobs).toEqual({
        type: 'mapping',
        total: 3,
        succeeded: 2,
        failed: 1,
        failedBy: [{ code: 'LLM_UNAVAILABLE', count: 1 }],
        cancelled: 0,
        active: 0,
        durationMs: { median: 1000, p95: 3000 },
      });
      expect(data.jobs.byType.find((j) => j.type === 'clustering')).toMatchObject({
        total: 1,
        cancelled: 1,
        durationMs: { median: null, p95: null },
      });
      expect(data.jobs.recentFailures).toEqual([
        { type: 'mapping', code: 'LLM_UNAVAILABLE', at: expect.any(String) as unknown },
      ]);

      expect(data.benchmarks).toEqual(JSON.parse(JSON.stringify(BENCHMARKS)));
      for (const item of data.benchmarks.items) expect(item.dataset).toBe('synthetic');

      const json = JSON.stringify(res.body);
      for (const value of RECORD_VALUES) expect(json).not.toContain(value);
      expect(json).not.toContain('exampleIds');
      expect(json).not.toContain('memberRecordIds');
      expect(json).not.toContain('owner@example.com');
    });

    it('limits range-bound sections to the range asked for', async () => {
      const steward = await memberWith('data_steward');
      await seedFullProject(steward);

      const week = await request(app).get(url('?range=7d')).set(bearer(owner)).expect(200);
      const quarter = await request(app).get(url('?range=90d')).set(bearer(owner)).expect(200);

      expect(week.body.data.range).toMatchObject({ key: '7d', days: 7 });
      expect(week.body.data.ai.total.calls).toBe(4);
      expect(week.body.data.ai.daily).toHaveLength(8);
      expect(quarter.body.data.ai.total.calls).toBe(5);
      expect(week.body.data.pipeline).toEqual(quarter.body.data.pipeline);
    });

    it('answers zeros and "Upload your first file" for an empty project', async () => {
      const res = await request(app).get(url()).set(bearer(owner)).expect(200);
      const { data } = res.body as { data: Dashboard };

      expect(data.pipeline.nextStep).toEqual({ text: 'Upload your first file', step: 'sources' });
      expect(data.pipeline.sources).toMatchObject({ count: 0, rowsUploaded: 0 });
      expect(data.pipeline.mapping).toMatchObject({ columns: 0, decided: 0, pending: 0 });
      expect(data.pipeline.clusters).toMatchObject({ ran: false, customers: 0, approved: 0 });
      expect(data.pipeline.sql).toEqual({ latest: null, approvedVersion: null, outdated: false });
      expect(data.pipeline.exports).toEqual({ count: 0, outdated: false });
      expect(data.pipeline.quality).toEqual({ latest: null, outdated: false });
      expect(data.quality).toEqual({ runs: [], latestRules: [] });
      expect(data.ai.tasks).toEqual([]);
      expect(data.ai.total).toMatchObject({
        calls: 0,
        costInr: 0,
        costLabel: 'free tier',
        latencyMs: { p50: null, p95: null, samples: 0 },
      });
      expect(data.review).toMatchObject({ total: 0, byRole: {}, medianTimeToDecisionMs: {} });
      expect(data.jobs).toEqual({ byType: [], recentFailures: [] });
      expect(data.benchmarks.items.length).toBeGreaterThan(0);
      expect(data.ai.budget).toBeNull(); // the mock provider keeps no daily cap
    });

    it("shows today's AI requests left, and null when the ai-service cannot say", async () => {
      const aiService = new FakeAiService();
      aiService.budget = {
        provider: 'gemini',
        model: 'gemini-3.5-flash-lite',
        dailyLimit: 400,
        usedToday: 150,
        projectDailyLimit: 200,
        projectUsedToday: 120,
        remainingToday: 80,
        resetsAt: '2026-11-27T08:00:00+00:00',
      };
      app = buildTestApp({ repos, aiService });
      const res = await request(app).get(url()).set(bearer(owner)).expect(200);
      const { data } = res.body as { data: Dashboard };

      expect(data.ai.budget).toEqual({
        dailyLimit: 400,
        usedToday: 150,
        projectDailyLimit: 200,
        projectUsedToday: 120,
        remainingToday: 80,
        resetsAt: '2026-11-27T08:00:00+00:00',
      });
      expect(aiService.budgetAsked).toEqual([projectId]);

      aiService.down = true;
      const down = await request(app).get(url()).set(bearer(owner)).expect(200);
      expect((down.body as { data: Dashboard }).data.ai.budget).toBeNull();
    });

    it('shows that steps are outdated once a source is profiled again', async () => {
      const steward = await memberWith('data_steward');
      await seedFullProject(steward);
      const [source] = await repos.sources.listByProject(projectId);
      await harness.markProfiled(repos, projectId, source?.id ?? '');

      const res = await request(app).get(url()).set(bearer(owner)).expect(200);
      const p = (res.body as { data: Dashboard }).data.pipeline;

      expect(p.standardise.outdated).toBe(true);
      expect(p.candidates.outdated).toBe(true);
      expect(p.scores.outdated).toBe(true);
      expect(p.clusters.outdated).toBe(true);
      expect(p.sql.outdated).toBe(true);
      expect(p.exports.outdated).toBe(true);
      expect(p.quality.outdated).toBe(true);
    });

    it('answers 400 for an unknown range or query field, 401 without a token', async () => {
      for (const query of ['?range=1y', '?range=', '?days=7']) {
        const res = await request(app).get(url(query)).set(bearer(owner));
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
      const bad = await request(app).get(url('', 'not-an-id')).set(bearer(owner));
      expect(bad.status).toBe(400);
      const anonymous = await request(app).get(url());
      expect(anonymous.status).toBe(401);
      expect(anonymous.body.error.code).toBe('UNAUTHORIZED');
    });

    it('lets every member read it, viewers included; 404 for a non-member', async () => {
      const viewer = await memberWith('viewer');
      const engineer = await memberWith('data_engineer');
      const stranger = await register('stranger@example.com');

      for (const session of [viewer, engineer]) {
        const res = await request(app).get(url()).set(bearer(session));
        expect(res.status).toBe(200);
      }
      const hidden = await request(app).get(url()).set(bearer(stranger));
      expect(hidden.status).toBe(404);
      expect(hidden.body.error.code).toBe('NOT_FOUND');
      const missing = await request(app).get(url('', newId())).set(bearer(owner));
      expect(missing.status).toBe(404);
    });
  });
}
