import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Cluster } from '../../src/modules/clusters/cluster.types.js';
import type { QualityRun } from '../../src/modules/quality/quality.types.js';
import type { Repositories } from '../../src/repositories.js';

import { buildTestApp, fastPasswords } from './build-app.js';
import { FakeAiService } from './fakes.js';
import {
  findCandidates,
  newId,
  prepareClusters,
  type PipelineContext,
} from './pipeline-fixtures.js';
import type { SqlHarness } from './sql-suite.js';

export interface QualityHarness extends SqlHarness {
  /** Saves a report as the Python `quality` job does. */
  workerQualityRun(repos: Repositories, run: QualityRun): Promise<void>;
}

interface Session {
  id: string;
  token: string;
}

type Role = 'viewer' | 'data_steward' | 'data_engineer';

const PASSWORD = 'correct horse battery';
const bearer = (s: Session) => ({ Authorization: `Bearer ${s.token}` });

/** The `quality` job and the quality reports and rules API (memory and MongoDB). */
export function defineQualitySuite(label: string, harness: QualityHarness): void {
  describe(`Data quality jobs, reports and rules API (${label})`, () => {
    let repos: Repositories;
    let ai: FakeAiService;
    let app: Express;
    let admin: Session;
    let owner: Session;
    let projectId: string;
    let clusters: Cluster[];

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

    const pipeline = (): PipelineContext => ({ repos, harness, projectId, ownerId: owner.id });

    async function approveFirstCustomer(): Promise<void> {
      await request(app)
        .post(`/api/v1/projects/${projectId}/clusters/${clusters[0]?.customerId ?? ''}/approve`)
        .set(bearer(owner))
        .send({})
        .expect(200);
    }

    async function approvedSqlVersion(): Promise<string> {
      const id = newId();
      await harness.workerSqlVersion(repos, {
        id,
        projectId,
        jobId: id,
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
        createdAt: new Date('2026-11-23T10:00:00Z'),
        clusteringRunId: 'job:1',
        schemaVersion: 1,
        lastRun: null,
        approvedBy: owner.id,
        approvedAt: new Date('2026-11-23T10:05:00Z'),
        rejectedBy: null,
        rejectedAt: null,
        rejectReason: null,
        supersededAt: null,
      });
      return id;
    }

    /** A report as the worker leaves it. */
    async function reported(minutesAfter: number, overrides: Partial<QualityRun> = {}) {
      const id = newId();
      const startedAt = new Date(Date.UTC(2026, 10, 23, 10, minutesAfter));
      const run: QualityRun = {
        id,
        projectId,
        jobId: id,
        startedAt,
        finishedAt: new Date(startedAt.getTime() + 1500),
        source: {
          kind: 'golden_records',
          label: 'Golden records of the approved customers (no approved SQL version)',
          versionId: null,
          version: null,
          scope: 'approved',
          sqlTestsPassed: true,
          failedChecks: [],
        },
        clusteringRunId: 'job:1',
        schemaVersion: 1,
        rowCount: 3,
        status: 'warn',
        statusCounts: { pass: 1, warn: 1, fail: 0, skipped: 0 },
        ruleCount: 2,
        results: [
          {
            rule: 'customer_id_unique',
            label: 'Every customer id present and unique',
            field: 'customer_id',
            status: 'pass',
            metric: 100,
            unit: 'percent',
            direction: 'min',
            threshold: { warn: 100, fail: 100 },
            message: 'Every customer id is present and unique.',
            counts: { rows: 3, missing: 0, repeatedIds: 0, extraRows: 0 },
            exampleIds: [],
          },
          {
            rule: 'completeness_optional',
            label: 'Optional field filled in',
            field: 'pin_code',
            status: 'warn',
            metric: 66.67,
            unit: 'percent',
            direction: 'min',
            threshold: { warn: 80, fail: 50 },
            message: '2 of 3 customers have a value (optional field).',
            counts: { rows: 3, filled: 2, empty: 1 },
            exampleIds: ['C3'],
          },
        ],
        config: { rules: {}, fields: {} },
        createdBy: owner.id,
        ...overrides,
      };
      await harness.workerQualityRun(repos, run);
      return run;
    }

    const url = (path = '', project = projectId) => `/api/v1/projects/${project}/quality${path}`;
    const startJob = (session: Session | null, payload: object = {}) => {
      const req = request(app)
        .post(`/api/v1/projects/${projectId}/jobs`)
        .send({ type: 'quality', payload });
      return session ? req.set(bearer(session)) : req;
    };
    const finish = (jobId: string) =>
      repos.jobs.finishIfActive(
        jobId,
        { status: 'cancelled', message: 'Cancelled', error: null },
        new Date(),
      );
    const jobIdOf = (res: request.Response) =>
      (res.body as { data: { job: { id: string } } }).data.job.id;

    async function auditEntries(): Promise<{ action: string; before: unknown; after: unknown }[]> {
      const page = await repos.audit.listByProject(projectId, { skip: 0, limit: 100 });
      return page.items.map((e) => ({ action: e.action, before: e.before, after: e.after }));
    }

    beforeEach(async () => {
      repos = await harness.setup();
      ai = new FakeAiService();
      app = buildTestApp({ repos, aiService: ai });
      clusters = [];
      admin = await register('first-admin@example.com');
      owner = await register('owner@example.com');
      const res = await request(app)
        .post('/api/v1/projects')
        .set(bearer(owner))
        .send({ name: 'Customer 360' })
        .expect(201);
      projectId = (res.body as { data: { project: { id: string } } }).data.project.id;
    });

    describe('POST /projects/:projectId/jobs (quality)', () => {
      it('starts for the owner, an admin, a data engineer and a data steward; audited', async () => {
        ({ clusters } = await prepareClusters(pipeline()));
        await approveFirstCustomer();
        const engineer = await memberWith('data_engineer');
        const steward = await memberWith('data_steward');
        for (const session of [owner, admin, engineer, steward]) {
          const res = await startJob(session);
          expect(res.status).toBe(202);
          await finish(jobIdOf(res));
        }
        expect(ai.enqueued.map(({ input }) => [input.type, input.payload])).toEqual(
          Array.from({ length: 4 }, () => ['quality', {}]),
        );
        const starts = (await auditEntries()).filter(
          (e) => e.action === 'job.create' && (e.after as { type?: string }).type === 'quality',
        );
        expect(starts).toHaveLength(4);
      });

      it('answers 400, 401, 403 for a viewer and 404 for a non-member', async () => {
        ({ clusters } = await prepareClusters(pipeline()));
        await approveFirstCustomer();
        const viewer = await memberWith('viewer');
        const stranger = await register('stranger@example.com');
        for (const payload of [{ scope: 'all' }, { versionId: newId() }]) {
          const res = await startJob(owner, payload);
          expect(res.status).toBe(400);
          expect(res.body.error.code).toBe('VALIDATION_ERROR');
        }
        expect((await startJob(null)).status).toBe(401);
        const forbidden = await startJob(viewer);
        expect(forbidden.status).toBe(403);
        expect(forbidden.body.error.code).toBe('FORBIDDEN');
        expect((await startJob(stranger)).status).toBe(404);
        expect(ai.enqueued).toEqual([]);
      });

      it('answers 409 before clustering, with nothing approved, while busy or outdated', async () => {
        const early = await startJob(owner);
        expect(early.status).toBe(409);
        expect(early.body.error.details).toEqual({ reason: 'CLUSTERS_NOT_RUN' });

        ({ clusters } = await prepareClusters(pipeline()));
        const none = await startJob(owner);
        expect(none.status).toBe(409);
        expect(none.body.error).toMatchObject({
          code: 'CONFLICT',
          message: expect.stringContaining('no approved SQL version') as string,
          details: { reason: 'NOTHING_APPROVED' },
        });

        // An approved SQL version is enough on its own: it defines the final table.
        await approvedSqlVersion();
        const first = await startJob(owner);
        expect(first.status).toBe(202);
        const busy = await startJob(owner);
        expect(busy.status).toBe(409);
        expect(busy.body.error.details).toEqual({ reason: 'QUALITY_RUNNING' });
        await finish(jobIdOf(first));

        const clustering = await repos.jobs.create({
          projectId,
          type: 'clustering',
          payload: {},
          createdBy: owner.id,
        });
        const building = await startJob(owner);
        expect(building.body.error.details).toEqual({ reason: 'CLUSTERING_RUNNING' });
        await finish(clustering.id);

        const [a = '', b = ''] = clusters[0]?.memberRecordIds ?? [];
        await findCandidates(pipeline(), [a, b]);
        const outdated = await startJob(owner);
        expect(outdated.status).toBe(409);
        expect(outdated.body.error.details).toEqual({ reason: 'CLUSTERS_OUTDATED' });
        expect(ai.enqueued).toHaveLength(1);
      });
    });

    describe('GET /projects/:projectId/quality/runs', () => {
      it('pages reports newest first for any member, without the results', async () => {
        const viewer = await memberWith('viewer');
        const older = await reported(1);
        const newer = await reported(2, { status: 'fail' });
        const res = await request(app).get(url('/runs')).set(bearer(viewer)).expect(200);
        const data = res.body.data as {
          items: Record<string, unknown>[];
          total: number;
          page: number;
          limit: number;
        };
        expect(data).toMatchObject({ total: 2, page: 1, limit: 20 });
        expect(data.items.map((r) => r.id)).toEqual([newer.id, older.id]);
        expect(data.items[0]).not.toHaveProperty('results');
        expect(data.items[0]).not.toHaveProperty('config');
        expect(data.items[0]).toMatchObject({ status: 'fail', rowCount: 3, ruleCount: 2 });
        const second = await request(app)
          .get(url('/runs?page=2&limit=1'))
          .set(bearer(owner))
          .expect(200);
        expect(second.body.data.items.map((r: { id: string }) => r.id)).toEqual([older.id]);
        expect(second.body.data.total).toBe(2);
      });

      it('answers 400, 401 and 404 for non-members', async () => {
        const stranger = await register('stranger@example.com');
        await request(app).get(url('/runs')).expect(401);
        await request(app).get(url('/runs')).set(bearer(stranger)).expect(404);
        for (const query of ['?limit=0', '?page=0', '?limit=101', '?sort=x']) {
          const bad = await request(app)
            .get(url(`/runs${query}`))
            .set(bearer(owner));
          expect(bad.status).toBe(400);
          expect(bad.body.error.code).toBe('VALIDATION_ERROR');
        }
        await request(app).get(url('/runs', 'nope')).set(bearer(owner)).expect(400);
      });
    });

    describe('GET /projects/:projectId/quality/runs/:runId', () => {
      it('shows one report with its results; 404 for unknown ids and other projects', async () => {
        const viewer = await memberWith('viewer');
        const run = await reported(1);
        const res = await request(app)
          .get(url(`/runs/${run.id}`))
          .set(bearer(viewer))
          .expect(200);
        expect(res.body.data.run).toMatchObject({
          id: run.id,
          status: 'warn',
          source: { kind: 'golden_records', versionId: null },
          results: [{ rule: 'customer_id_unique', status: 'pass' }, { exampleIds: ['C3'] }],
        });
        await request(app)
          .get(url(`/runs/${newId()}`))
          .set(bearer(owner))
          .expect(404);
        await request(app).get(url('/runs/xyz')).set(bearer(owner)).expect(400);
        await request(app)
          .get(url(`/runs/${run.id}`))
          .expect(401);
        const stranger = await register('stranger@example.com');
        await request(app)
          .get(url(`/runs/${run.id}`))
          .set(bearer(stranger))
          .expect(404);
        const other = await request(app)
          .post('/api/v1/projects')
          .set(bearer(owner))
          .send({ name: 'Other' })
          .expect(201);
        const otherId = (other.body as { data: { project: { id: string } } }).data.project.id;
        await request(app)
          .get(url(`/runs/${run.id}`, otherId))
          .set(bearer(owner))
          .expect(404);
      });
    });

    describe('GET /projects/:projectId/quality/latest', () => {
      it('is null before the first check, then the newest report', async () => {
        const viewer = await memberWith('viewer');
        const empty = await request(app).get(url('/latest')).set(bearer(viewer)).expect(200);
        expect(empty.body).toEqual({ data: { run: null }, error: null });
        await reported(1);
        const newest = await reported(5, { status: 'pass' });
        const res = await request(app).get(url('/latest')).set(bearer(viewer)).expect(200);
        expect(res.body.data.run).toMatchObject({ id: newest.id, status: 'pass' });
        expect(res.body.data.run.results).toHaveLength(2);
      });

      it('answers 401 and 404 for non-members', async () => {
        const stranger = await register('stranger@example.com');
        await request(app).get(url('/latest')).expect(401);
        await request(app).get(url('/latest')).set(bearer(stranger)).expect(404);
        await request(app).get(url('/latest', 'bad')).set(bearer(owner)).expect(400);
      });
    });

    describe('GET and PUT /projects/:projectId/quality/rules', () => {
      const body = {
        rules: {
          validity: { warn: 98, fail: 90 },
          phone_shared: { enabled: false },
          row_count_change: { warn: 10, fail: null },
        },
        fields: { email: { warn: 95 } },
      };

      it('shows the defaults (no overrides) and what can be configured to any member', async () => {
        const viewer = await memberWith('viewer');
        const res = await request(app).get(url('/rules')).set(bearer(viewer)).expect(200);
        const rules = res.body.data.rules as Record<string, unknown> & {
          catalogue: { rule: string; direction: string; max: number }[];
        };
        expect(rules).toMatchObject({ rules: {}, fields: {}, updatedBy: null, updatedAt: null });
        expect(rules.catalogue.map((c) => c.rule)).not.toContain('customer_id_unique');
        expect(rules.catalogue).toContainEqual({
          rule: 'clustering_freshness',
          direction: 'max',
          max: 8760,
        });
      });

      it('saves overrides for an engineer, replaces them on the next PUT; audited', async () => {
        const engineer = await memberWith('data_engineer');
        const res = await request(app)
          .put(url('/rules'))
          .set(bearer(engineer))
          .send(body)
          .expect(200);
        expect(res.body.data.rules).toMatchObject({ ...body, updatedBy: engineer.id });
        const read = await request(app).get(url('/rules')).set(bearer(owner)).expect(200);
        expect(read.body.data.rules).toMatchObject(body);

        const replaced = await request(app)
          .put(url('/rules'))
          .set(bearer(admin))
          .send({ rules: { validity: { enabled: false } } })
          .expect(200);
        expect(replaced.body.data.rules).toMatchObject({
          rules: { validity: { enabled: false } },
          fields: {},
          updatedBy: admin.id,
        });
        const entries = (await auditEntries()).filter((e) => e.action === 'quality_rules.update');
        expect(entries).toHaveLength(2);
        const [latest, first] = entries;
        expect(first?.before).toBeNull();
        expect(first?.after).toEqual(body);
        expect(latest?.before).toEqual(body);
      });

      it('refuses invalid overrides with 400', async () => {
        for (const bad of [
          { rules: { customer_id_unique: { enabled: false } } },
          { rules: { unknown: { warn: 1 } } },
          { rules: { validity: { warn: 90, fail: 95 } } },
          { rules: { row_count_change: { warn: 50, fail: 10 } } },
          { rules: { validity: { warn: 101 } } },
          { rules: { clustering_freshness: { warn: 9000 } } },
          { rules: { validity: { warn: -1 } } },
          { rules: { validity: { warn: '90' } } },
          { rules: { validity: { threshold: 1 } } },
          { fields: { Email: { warn: 1 } } },
          { fields: { email: { warn: 50, fail: 60 } } },
          { fields: { email: { enabled: false } } },
          { fields: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`f${i}`, {}])) },
          { other: true },
        ]) {
          const res = await request(app).put(url('/rules')).set(bearer(owner)).send(bad);
          expect(res.status, JSON.stringify(bad)).toBe(400);
          expect(res.body.error.code).toBe('VALIDATION_ERROR');
        }
        expect(await repos.quality.findRules(projectId)).toBeNull();
      });

      it('answers 401, 403 for viewers and stewards and 404 for non-members', async () => {
        const viewer = await memberWith('viewer');
        const steward = await memberWith('data_steward');
        const stranger = await register('stranger@example.com');
        await request(app).get(url('/rules')).expect(401);
        await request(app).get(url('/rules')).set(bearer(stranger)).expect(404);
        await request(app).put(url('/rules')).send(body).expect(401);
        for (const session of [viewer, steward]) {
          const res = await request(app).put(url('/rules')).set(bearer(session)).send(body);
          expect(res.status).toBe(403);
          expect(res.body.error.code).toBe('FORBIDDEN');
        }
        await request(app).put(url('/rules')).set(bearer(stranger)).send(body).expect(404);
        expect(await repos.quality.findRules(projectId)).toBeNull();
      });
    });

    it('deletes reports and rules with the project', async () => {
      await reported(1);
      await request(app).put(url('/rules')).set(bearer(owner)).send({}).expect(200);
      await request(app).delete(`/api/v1/projects/${projectId}`).set(bearer(owner)).expect(204);
      expect(await repos.quality.latestRun(projectId)).toBeNull();
      expect(await repos.quality.findRules(projectId)).toBeNull();
    });
  });
}
