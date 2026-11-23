import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Cluster } from '../../src/modules/clusters/cluster.types.js';
import type { SqlVersion } from '../../src/modules/sql/sql.types.js';
import type { Repositories } from '../../src/repositories.js';

import { buildTestApp, fastPasswords } from './build-app.js';
import type { ClustersHarness } from './clusters-suite.js';
import { FakeAiService } from './fakes.js';
import {
  findCandidates,
  newId,
  prepareClusters,
  type PipelineContext,
} from './pipeline-fixtures.js';

export interface SqlHarness extends ClustersHarness {
  /** Saves a version as the Python `sql_draft` job does. */
  workerSqlVersion(repos: Repositories, version: SqlVersion): Promise<void>;
}

interface Session {
  id: string;
  token: string;
}

type Role = 'viewer' | 'data_steward' | 'data_engineer';

const PASSWORD = 'correct horse battery';
const bearer = (s: Session) => ({ Authorization: `Bearer ${s.token}` });

/** The SQL agent's jobs and the versions API: list, read, approve, reject (memory and MongoDB). */
export function defineSqlSuite(label: string, harness: SqlHarness): void {
  describe(`SQL agent jobs and versions API (${label})`, () => {
    let repos: Repositories;
    let ai: FakeAiService;
    let app: Express;
    let admin: Session;
    let owner: Session;
    let projectId: string;
    let clusters: Cluster[];
    let nextVersion: number;

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

    async function prepare(): Promise<void> {
      ({ clusters } = await prepareClusters(pipeline()));
    }

    async function approveFirstCustomer(): Promise<void> {
      await request(app)
        .post(`/api/v1/projects/${projectId}/clusters/${clusters[0]?.customerId ?? ''}/approve`)
        .set(bearer(owner))
        .send({})
        .expect(200);
    }

    /** A version as the worker leaves it. */
    async function drafted(overrides: Partial<SqlVersion> = {}): Promise<SqlVersion> {
      const id = newId();
      const passed = overrides.testsPassed ?? true;
      const version: SqlVersion = {
        id,
        projectId,
        jobId: id,
        version: nextVersion++,
        sql: 'SELECT g."customer_id" FROM golden_records AS g',
        explanation: 'Takes the golden records.',
        assumptions: ['Golden values are final.'],
        method: 'llm',
        model: 'mock',
        promptVersion: 'sql_agent.v1',
        fallbackReason: null,
        scope: 'approved',
        instructions: null,
        validation: { ok: true, code: null, message: null },
        error: null,
        tests: {
          passed,
          checks: [
            { name: 'columns', status: 'passed', message: 'ok', details: {} },
            {
              name: 'golden_equality',
              status: passed ? 'passed' : 'failed',
              message: passed ? 'ok' : 'Some fields differ',
              details: {},
            },
          ],
          summary: {
            passedCount: passed ? 2 : 1,
            checkCount: 2,
            rowCount: 1,
            expectedRowCount: 1,
            durationMs: 3,
          },
        },
        testsPassed: passed,
        attempts: [{ attempt: 1, passed }],
        usage: { calls: 1, inputTokens: 100, outputTokens: 20, costInr: 0, latencyMs: 5 },
        status: 'draft',
        createdBy: owner.id,
        createdAt: new Date('2026-11-23T10:00:00Z'),
        clusteringRunId: 'job:1',
        schemaVersion: 1,
        lastRun: null,
        approvedBy: null,
        approvedAt: null,
        rejectedBy: null,
        rejectedAt: null,
        rejectReason: null,
        supersededAt: null,
        ...overrides,
      };
      await harness.workerSqlVersion(repos, version);
      return version;
    }

    const url = (path = '', project = projectId) => `/api/v1/projects/${project}/sql${path}`;
    const startJob = (session: Session | null, type: string, payload: object) => {
      const req = request(app).post(`/api/v1/projects/${projectId}/jobs`).send({ type, payload });
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

    async function auditActions(): Promise<{ action: string; after: unknown }[]> {
      const page = await repos.audit.listByProject(projectId, { skip: 0, limit: 100 });
      return page.items.map((e) => ({ action: e.action, after: e.after }));
    }

    beforeEach(async () => {
      repos = await harness.setup();
      ai = new FakeAiService();
      app = buildTestApp({ repos, aiService: ai });
      clusters = [];
      nextVersion = 1;
      admin = await register('first-admin@example.com');
      owner = await register('owner@example.com');
      const res = await request(app)
        .post('/api/v1/projects')
        .set(bearer(owner))
        .send({ name: 'Customer 360' })
        .expect(201);
      projectId = (res.body as { data: { project: { id: string } } }).data.project.id;
    });

    describe('POST /projects/:projectId/jobs (sql_draft)', () => {
      it('starts for the owner, an admin and a data engineer; audited', async () => {
        await prepare();
        await approveFirstCustomer();
        const engineer = await memberWith('data_engineer');
        for (const session of [owner, admin, engineer]) {
          const res = await startJob(session, 'sql_draft', { instructions: '  Keep it simple. ' });
          expect(res.status).toBe(202);
          const job = (res.body as { data: { job: { id: string; payload: unknown } } }).data.job;
          expect(job.payload).toEqual({ instructions: 'Keep it simple.', scope: 'approved' });
          await finish(job.id);
        }
        expect(ai.enqueued.map(({ input }) => input.type)).toEqual([
          'sql_draft',
          'sql_draft',
          'sql_draft',
        ]);
        const starts = (await auditActions()).filter(
          (e) => e.action === 'job.create' && (e.after as { type?: string }).type === 'sql_draft',
        );
        expect(starts).toHaveLength(3);
      });

      it('answers 401, 403 for a viewer or data steward and 404 for a non-member', async () => {
        await prepare();
        const viewer = await memberWith('viewer');
        const steward = await memberWith('data_steward');
        const stranger = await register('stranger@example.com');
        expect((await startJob(null, 'sql_draft', { scope: 'all' })).status).toBe(401);
        for (const session of [viewer, steward]) {
          const res = await startJob(session, 'sql_draft', { scope: 'all' });
          expect(res.status).toBe(403);
          expect(res.body.error.code).toBe('FORBIDDEN');
        }
        expect((await startJob(stranger, 'sql_draft', { scope: 'all' })).status).toBe(404);
        expect(ai.enqueued).toEqual([]);
      });

      it('validates the payload', async () => {
        await prepare();
        for (const payload of [
          { scope: 'some' },
          { instructions: 'x'.repeat(501) },
          { instructions: 42 },
          { sql: 'select 1' },
        ]) {
          const res = await startJob(owner, 'sql_draft', payload);
          expect(res.status).toBe(400);
          expect(res.body.error.code).toBe('VALIDATION_ERROR');
        }
        expect(ai.enqueued).toEqual([]);
      });

      it('answers 409 before clustering, with nothing approved, while busy or outdated', async () => {
        const early = await startJob(owner, 'sql_draft', { scope: 'all' });
        expect(early.status).toBe(409);
        expect(early.body.error.details).toEqual({ reason: 'CLUSTERS_NOT_RUN' });

        await prepare();
        const none = await startJob(owner, 'sql_draft', {});
        expect(none.status).toBe(409);
        expect(none.body.error).toMatchObject({
          code: 'CONFLICT',
          message: expect.stringContaining('No customer is approved yet') as string,
          details: { reason: 'NOTHING_APPROVED' },
        });

        const first = await startJob(owner, 'sql_draft', { scope: 'all' });
        expect(first.status).toBe(202);
        const busy = await startJob(owner, 'sql_draft', { scope: 'all' });
        expect(busy.status).toBe(409);
        expect(busy.body.error.details).toEqual({ reason: 'SQL_DRAFT_RUNNING' });
        await finish(jobIdOf(first));

        const clustering = await repos.jobs.create({
          projectId,
          type: 'clustering',
          payload: {},
          createdBy: owner.id,
        });
        const building = await startJob(owner, 'sql_draft', { scope: 'all' });
        expect(building.body.error.details).toEqual({ reason: 'CLUSTERING_RUNNING' });
        await finish(clustering.id);

        const [a = '', b = ''] = clusters[0]?.memberRecordIds ?? [];
        await findCandidates(pipeline(), [a, b]);
        const outdated = await startJob(owner, 'sql_draft', { scope: 'all' });
        expect(outdated.body.error.details).toEqual({ reason: 'CLUSTERS_OUTDATED' });
        expect(ai.enqueued).toHaveLength(1);
      });
    });

    describe('POST /projects/:projectId/jobs (sql_run)', () => {
      it('runs an approved version for a data engineer; audited', async () => {
        await prepare();
        const version = await drafted({ status: 'approved' });
        const engineer = await memberWith('data_engineer');
        const res = await startJob(engineer, 'sql_run', { versionId: version.id });
        expect(res.status).toBe(202);
        expect(ai.enqueued.map(({ input }) => input.payload)).toEqual([{ versionId: version.id }]);
        const run = (await auditActions()).find((e) => e.action === 'sql_version.run');
        expect(run?.after).toEqual({ jobId: jobIdOf(res) });
      });

      it('answers 400, 401, 403, 404 and 409', async () => {
        await prepare();
        const draft = await drafted();
        const approved = await drafted({ status: 'approved' });
        const viewer = await memberWith('viewer');
        const stranger = await register('stranger@example.com');

        expect((await startJob(owner, 'sql_run', { versionId: '../x' })).status).toBe(400);
        expect((await startJob(owner, 'sql_run', {})).status).toBe(400);
        expect((await startJob(null, 'sql_run', { versionId: approved.id })).status).toBe(401);
        expect((await startJob(viewer, 'sql_run', { versionId: approved.id })).status).toBe(403);
        expect((await startJob(stranger, 'sql_run', { versionId: approved.id })).status).toBe(404);
        const unknown = await startJob(owner, 'sql_run', { versionId: newId() });
        expect(unknown.status).toBe(404);
        const notApproved = await startJob(owner, 'sql_run', { versionId: draft.id });
        expect(notApproved.status).toBe(409);
        expect(notApproved.body.error.details).toEqual({ reason: 'SQL_VERSION_NOT_APPROVED' });

        const [a = '', b = ''] = clusters[0]?.memberRecordIds ?? [];
        await findCandidates(pipeline(), [a, b]);
        const outdated = await startJob(owner, 'sql_run', { versionId: approved.id });
        expect(outdated.body.error.details).toEqual({ reason: 'CLUSTERS_OUTDATED' });
        expect(ai.enqueued).toEqual([]);
      });
    });

    describe('GET /projects/:projectId/sql/versions', () => {
      it('lists versions newest first for any member, without the query text', async () => {
        const viewer = await memberWith('viewer');
        await drafted();
        await drafted({ testsPassed: false });
        const res = await request(app).get(url('/versions')).set(bearer(viewer)).expect(200);
        const items = (res.body as { data: { items: Record<string, unknown>[] } }).data.items;
        expect(items.map((v) => v.version)).toEqual([2, 1]);
        expect(items[0]).not.toHaveProperty('sql');
        expect(items[0]).not.toHaveProperty('attempts');
        expect(items[0]).toMatchObject({ status: 'draft', testsPassed: false, method: 'llm' });
        const limited = await request(app).get(url('/versions?limit=1')).set(bearer(owner));
        expect((limited.body as { data: { items: unknown[] } }).data.items).toHaveLength(1);
      });

      it('answers 400, 401 and 404 for non-members', async () => {
        const stranger = await register('stranger@example.com');
        await request(app).get(url('/versions')).expect(401);
        await request(app).get(url('/versions')).set(bearer(stranger)).expect(404);
        const bad = await request(app).get(url('/versions?limit=0')).set(bearer(owner));
        expect(bad.status).toBe(400);
        expect(bad.body.error.code).toBe('VALIDATION_ERROR');
        await request(app).get(url('/versions', 'nope')).set(bearer(owner)).expect(400);
      });
    });

    describe('GET /projects/:projectId/sql/versions/:versionId', () => {
      it('shows one version with its query and tests; 404 for unknown or other projects', async () => {
        const viewer = await memberWith('viewer');
        const version = await drafted();
        const res = await request(app)
          .get(url(`/versions/${version.id}`))
          .set(bearer(viewer))
          .expect(200);
        expect(res.body.data.version).toMatchObject({
          id: version.id,
          sql: version.sql,
          tests: { passed: true },
          attempts: [{ attempt: 1, passed: true }],
        });
        await request(app)
          .get(url(`/versions/${newId()}`))
          .set(bearer(owner))
          .expect(404);
        await request(app).get(url('/versions/xyz')).set(bearer(owner)).expect(400);
        await request(app)
          .get(url(`/versions/${version.id}`))
          .expect(401);
        const stranger = await register('stranger@example.com');
        await request(app)
          .get(url(`/versions/${version.id}`))
          .set(bearer(stranger))
          .expect(404);

        const other = await request(app)
          .post('/api/v1/projects')
          .set(bearer(owner))
          .send({ name: 'Other' })
          .expect(201);
        const otherId = (other.body as { data: { project: { id: string } } }).data.project.id;
        await request(app)
          .get(url(`/versions/${version.id}`, otherId))
          .set(bearer(owner))
          .expect(404);
      });
    });

    describe('POST /projects/:projectId/sql/versions/:versionId/approve', () => {
      it('approves a passing draft and supersedes the approved one; audited', async () => {
        const engineer = await memberWith('data_engineer');
        const first = await drafted();
        const second = await drafted();
        await request(app)
          .post(url(`/versions/${first.id}/approve`))
          .set(bearer(owner))
          .send({})
          .expect(200);
        const res = await request(app)
          .post(url(`/versions/${second.id}/approve`))
          .set(bearer(engineer))
          .send({})
          .expect(200);
        expect(res.body.data.version).toMatchObject({
          id: second.id,
          status: 'approved',
          approvedBy: engineer.id,
        });
        const firstNow = await repos.sqlVersions.findById(projectId, first.id);
        expect(firstNow?.status).toBe('superseded');
        expect(firstNow?.supersededAt).toBeInstanceOf(Date);
        const approvals = (await auditActions()).filter((e) => e.action === 'sql_version.approve');
        expect(approvals).toHaveLength(2);
        expect(approvals[0]?.after).toMatchObject({ version: 2, supersededVersions: [1] });
      });

      it('answers 409 SQL_TESTS_FAILED for a failing version and 409 when not a draft', async () => {
        const failing = await drafted({ testsPassed: false });
        const res = await request(app)
          .post(url(`/versions/${failing.id}/approve`))
          .set(bearer(owner))
          .send({});
        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({
          code: 'CONFLICT',
          message: expect.stringContaining('golden_equality') as string,
          details: { reason: 'SQL_TESTS_FAILED', failedChecks: ['golden_equality'] },
        });
        const rejected = await drafted({ status: 'rejected' });
        const again = await request(app)
          .post(url(`/versions/${rejected.id}/approve`))
          .set(bearer(owner))
          .send({});
        expect(again.status).toBe(409);
        expect(again.body.error.details).toEqual({ reason: 'SQL_VERSION_NOT_DRAFT' });
        expect((await auditActions()).map((e) => e.action)).not.toContain('sql_version.approve');
      });

      it('answers 400, 401, 403 for viewers and stewards, 404 for non-members', async () => {
        const version = await drafted();
        const viewer = await memberWith('viewer');
        const steward = await memberWith('data_steward');
        const stranger = await register('stranger@example.com');
        const approve = (session: Session | null, body: object = {}, id = version.id) => {
          const req = request(app)
            .post(url(`/versions/${id}/approve`))
            .send(body);
          return session ? req.set(bearer(session)) : req;
        };
        expect((await approve(null)).status).toBe(401);
        expect((await approve(viewer)).status).toBe(403);
        expect((await approve(steward)).status).toBe(403);
        expect((await approve(stranger)).status).toBe(404);
        expect((await approve(owner, { force: true })).status).toBe(400);
        expect((await approve(owner, {}, 'bad')).status).toBe(400);
        expect((await approve(owner, {}, newId())).status).toBe(404);
        const still = await repos.sqlVersions.findById(projectId, version.id);
        expect(still?.status).toBe('draft');
      });
    });

    describe('POST /projects/:projectId/sql/versions/:versionId/reject', () => {
      it('rejects a draft or an approved version with an optional reason; audited', async () => {
        const draft = await drafted();
        const approved = await drafted({ status: 'approved' });
        const res = await request(app)
          .post(url(`/versions/${draft.id}/reject`))
          .set(bearer(owner))
          .send({ reason: '  Wrong scope.  ' })
          .expect(200);
        expect(res.body.data.version).toMatchObject({
          status: 'rejected',
          rejectReason: 'Wrong scope.',
          rejectedBy: owner.id,
        });
        const plain = await request(app)
          .post(url(`/versions/${approved.id}/reject`))
          .set(bearer(admin))
          .send({})
          .expect(200);
        expect(plain.body.data.version).toMatchObject({ status: 'rejected', rejectReason: null });
        const entries = (await auditActions()).filter((e) => e.action === 'sql_version.reject');
        expect(entries.map((e) => (e.after as { reason: unknown }).reason)).toEqual([
          null,
          'Wrong scope.',
        ]);

        const twice = await request(app)
          .post(url(`/versions/${draft.id}/reject`))
          .set(bearer(owner))
          .send({});
        expect(twice.status).toBe(409);
        expect(twice.body.error.details).toEqual({ reason: 'SQL_VERSION_DECIDED' });
      });

      it('answers 400, 401, 403 and 404', async () => {
        const version = await drafted();
        const viewer = await memberWith('viewer');
        const stranger = await register('stranger@example.com');
        const reject = (session: Session | null, body: object = {}) => {
          const req = request(app)
            .post(url(`/versions/${version.id}/reject`))
            .send(body);
          return session ? req.set(bearer(session)) : req;
        };
        expect((await reject(null)).status).toBe(401);
        expect((await reject(viewer)).status).toBe(403);
        expect((await reject(stranger)).status).toBe(404);
        expect((await reject(owner, { reason: 'x'.repeat(501) })).status).toBe(400);
        expect((await reject(owner, { reason: 7 })).status).toBe(400);
        expect((await reject(owner, { reason: '' })).status).toBe(400);
        const rejectUnknown = await request(app)
          .post(url(`/versions/${newId()}/reject`))
          .set(bearer(owner))
          .send({});
        expect(rejectUnknown.status).toBe(404);
      });
    });

    it('deletes every version with the project', async () => {
      await drafted();
      await request(app).delete(`/api/v1/projects/${projectId}`).set(bearer(owner)).expect(204);
      expect(await repos.sqlVersions.listByProject(projectId, 10)).toEqual([]);
    });
  });
}
