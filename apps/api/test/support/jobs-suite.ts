import { randomBytes } from 'node:crypto';

import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { QUEUE_UNAVAILABLE_MESSAGE } from '../../src/modules/jobs/job.service.js';
import type { Repositories } from '../../src/repositories.js';

import type { Harness } from './api-suite.js';
import { buildTestApp, fastPasswords } from './build-app.js';
import { FakeAiService, MemoryJobEventBus } from './fakes.js';
import type { WorkerPatch } from './memory-repositories.js';
import { listen, SseClient } from './sse-client.js';

export interface JobsHarness extends Harness {
  /** Writes job fields directly, as the Python worker does. */
  workerUpdate(repos: Repositories, jobId: string, patch: WorkerPatch): Promise<void>;
}

interface Session {
  id: string;
  token: string;
}

const PASSWORD = 'correct horse battery';
const DEMO = { type: 'demo', payload: { steps: 3, stepMs: 50 } };
const bearer = (s: Session) => ({ Authorization: `Bearer ${s.token}` });

async function eventually(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Job routes and live progress, run against in-memory repositories and real MongoDB. */
export function defineJobsSuite(label: string, harness: JobsHarness): void {
  describe(`Jobs API (${label})`, () => {
    let repos: Repositories;
    let events: MemoryJobEventBus;
    let ai: FakeAiService;
    let app: Express;
    let owner: Session;
    let projectId: string;
    const servers: (() => Promise<void>)[] = [];
    const clients: SseClient[] = [];

    function appWith(env: NodeJS.ProcessEnv = {}): Express {
      return buildTestApp({ repos, jobEvents: events, aiService: ai, env });
    }

    beforeEach(async () => {
      repos = await harness.setup();
      events = new MemoryJobEventBus();
      ai = new FakeAiService();
      app = appWith();
      owner = await register('owner@example.com');
      projectId = await newProject(owner);
    });

    afterEach(async () => {
      for (const client of clients.splice(0)) client.close();
      for (const close of servers.splice(0)) await close();
    });

    async function register(email: string): Promise<Session> {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ email, name: 'User', password: PASSWORD })
        .expect(201);
      const body = res.body as { data: { user: { id: string }; accessToken: string } };
      return { id: body.data.user.id, token: body.data.accessToken };
    }

    async function newProject(session: Session): Promise<string> {
      const res = await request(app)
        .post('/api/v1/projects')
        .set(bearer(session))
        .send({ name: 'Customer 360' })
        .expect(201);
      return (res.body as { data: { project: { id: string } } }).data.project.id;
    }

    async function memberWith(role: 'viewer' | 'data_steward' | 'data_engineer') {
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

    async function startJob(body: object = DEMO, session: Session = owner): Promise<string> {
      const res = await request(app)
        .post(`/api/v1/projects/${projectId}/jobs`)
        .set(bearer(session))
        .send(body)
        .expect(202);
      return (res.body as { data: { job: { id: string } } }).data.job.id;
    }

    async function stream(jobId: string, session: Session = owner, target = app) {
      const server = await listen(target);
      servers.push(server.close);
      const client = await SseClient.open(
        `${server.url}/api/v1/jobs/${jobId}/events`,
        session.token,
      );
      clients.push(client);
      return client;
    }

    describe('POST /projects/:projectId/jobs', () => {
      it('saves a queued job, hands it to the ai-service and answers 202', async () => {
        const res = await request(app)
          .post(`/api/v1/projects/${projectId}/jobs`)
          .set(bearer(owner))
          .set('X-Request-Id', 'req-job-1')
          .send({ type: 'demo', payload: { steps: 5, stepMs: 200, failAtStep: 5 } });

        expect(res.status).toBe(202);
        const job = (res.body as { data: { job: { id: string } } }).data.job;
        expect(job).toMatchObject({
          projectId,
          type: 'demo',
          status: 'queued',
          progress: 0,
          payload: { steps: 5, stepMs: 200, failAtStep: 5 },
          result: null,
          error: null,
          attempts: 0,
          createdBy: owner.id,
          startedAt: null,
          finishedAt: null,
        });
        expect(ai.enqueued).toEqual([
          {
            input: {
              jobId: job.id,
              projectId,
              type: 'demo',
              payload: { steps: 5, stepMs: 200, failAtStep: 5 },
            },
            requestId: 'req-job-1',
          },
        ]);
        const audit = await repos.audit.listByProject(projectId, { skip: 0, limit: 1 });
        expect(audit.items[0]).toMatchObject({ action: 'job.create', entityId: job.id });
      });

      it('lets data_engineer members and admins start jobs, not viewers or stewards', async () => {
        const engineer = await memberWith('data_engineer');
        const viewer = await memberWith('viewer');
        const steward = await memberWith('data_steward');
        const outsider = await register('outsider@example.com');

        await startJob(DEMO, engineer);
        for (const session of [viewer, steward]) {
          const res = await request(app)
            .post(`/api/v1/projects/${projectId}/jobs`)
            .set(bearer(session))
            .send(DEMO);
          expect(res.status).toBe(403);
        }
        const hidden = await request(app)
          .post(`/api/v1/projects/${projectId}/jobs`)
          .set(bearer(outsider))
          .send(DEMO);
        expect(hidden.status).toBe(404);
        expect(ai.enqueued).toHaveLength(1);
      });

      it('rejects unknown types and invalid payloads with field errors', async () => {
        const post = (body: object) =>
          request(app).post(`/api/v1/projects/${projectId}/jobs`).set(bearer(owner)).send(body);

        const unknown = await post({ type: 'mine_bitcoin', payload: {} });
        expect(unknown.status).toBe(400);
        expect(unknown.body.error.details).toEqual([
          { field: 'body.type', message: 'unknown job type' },
        ]);
        expect((await post({ type: 'profile', payload: {} })).status).toBe(400);

        const bad = await post({
          type: 'demo',
          payload: { steps: 0, stepMs: 5000, extra: true },
          priority: 'high',
        });
        expect(bad.status).toBe(400);
        const fields = (bad.body.error.details as { field: string }[]).map((d) => d.field);
        expect(fields).toEqual(
          expect.arrayContaining(['body.payload.steps', 'body.payload.stepMs', 'body.payload']),
        );
        expect(fields).toContain('body');

        const failAfterEnd = await post({
          type: 'demo',
          payload: { steps: 2, stepMs: 10, failAtStep: 3 },
        });
        expect(failAfterEnd.body.error.details).toEqual([
          { field: 'body.payload.failAtStep', message: 'must not be greater than steps' },
        ]);
        expect(ai.enqueued).toHaveLength(0);
      });

      it('fails the job with QUEUE_UNAVAILABLE and answers 503 when enqueueing fails', async () => {
        ai.down = true;
        const res = await request(app)
          .post(`/api/v1/projects/${projectId}/jobs`)
          .set(bearer(owner))
          .send(DEMO);

        expect(res.status).toBe(503);
        expect(res.body.error).toMatchObject({
          code: 'QUEUE_UNAVAILABLE',
          message: QUEUE_UNAVAILABLE_MESSAGE,
        });
        const jobId = res.body.error.details.jobId as string;
        expect(await repos.jobs.findById(jobId)).toMatchObject({
          status: 'failed',
          error: { code: 'QUEUE_UNAVAILABLE' },
        });
        expect(events.published).toEqual([
          { jobId, update: expect.objectContaining({ status: 'failed' }) as unknown },
        ]);
      });

      it('validates the project id and requires authentication', async () => {
        await request(app)
          .post('/api/v1/projects/nope/jobs')
          .set(bearer(owner))
          .send(DEMO)
          .expect(400);
        await request(app).post(`/api/v1/projects/${projectId}/jobs`).send(DEMO).expect(401);
      });
    });

    describe('POST /projects/:projectId/jobs with type "profile"', () => {
      async function addSource(project = projectId): Promise<string> {
        const id = randomBytes(12).toString('hex');
        await repos.sources.create({
          id,
          projectId: project,
          name: 'CRM',
          systemName: null,
          originalFilename: 'crm.csv',
          fileKey: `projects/${project}/sources/${id}/original.csv`,
          format: 'csv',
          sizeBytes: 100,
          sha256: randomBytes(32).toString('hex'),
          rowCount: 2,
          columnCount: 3,
          uploadedBy: owner.id,
        });
        return id;
      }

      const profile = (sourceId: string) => ({ type: 'profile', payload: { sourceId } });
      const post = (body: object, session: Session = owner) =>
        request(app).post(`/api/v1/projects/${projectId}/jobs`).set(bearer(session)).send(body);

      it('queues a profile job for a source of the project', async () => {
        const sourceId = await addSource();

        const res = await post(profile(sourceId));

        expect(res.status).toBe(202);
        expect(res.body.data.job).toMatchObject({
          type: 'profile',
          status: 'queued',
          payload: { sourceId },
        });
        const jobId = (res.body as { data: { job: { id: string } } }).data.job.id;
        expect(ai.enqueued.map((e) => e.input)).toEqual([
          { jobId, projectId, type: 'profile', payload: { sourceId } },
        ]);
      });

      it('answers 404 for an unknown source or one of another project', async () => {
        const outsider = await register('outsider@example.com');
        const res = await request(app)
          .post('/api/v1/projects')
          .set(bearer(outsider))
          .send({ name: 'Other' })
          .expect(201);
        const foreign = await addSource(
          (res.body as { data: { project: { id: string } } }).data.project.id,
        );

        for (const sourceId of [randomBytes(12).toString('hex'), foreign]) {
          const missing = await post(profile(sourceId));
          expect(missing.status).toBe(404);
          expect(missing.body.error).toMatchObject({
            code: 'NOT_FOUND',
            message: 'Source not found.',
          });
        }
        expect(ai.enqueued).toEqual([]);
      });

      it('answers 409 while another profile job works on the same source', async () => {
        const sourceId = await addSource();
        const otherSource = await addSource();
        const first = await startJob(profile(sourceId));
        await startJob(DEMO); // other job types never block a profile

        const busy = await post(profile(sourceId));
        expect(busy.status).toBe(409);
        expect(busy.body.error.code).toBe('CONFLICT');
        expect(busy.body.error.message).toMatch(/already being profiled/);
        await harness.workerUpdate(repos, first, { status: 'running', attempts: 1 });
        expect((await post(profile(sourceId))).status).toBe(409);
        expect((await post(profile(otherSource))).status).toBe(202);

        await harness.workerUpdate(repos, first, { status: 'succeeded', progress: 100 });
        expect((await post(profile(sourceId))).status).toBe(202);
      });

      it('does not let a stale job block a new profile', async () => {
        const stale = appWith({ JOB_STALE_AFTER_SECONDS: '60' });
        const sourceId = await addSource();
        const first = await startJob(profile(sourceId));
        const old = new Date(Date.now() - 61_000);
        await harness.workerUpdate(repos, first, {
          status: 'running',
          attempts: 1,
          startedAt: old,
          heartbeatAt: old,
        });

        const res = await request(stale)
          .post(`/api/v1/projects/${projectId}/jobs`)
          .set(bearer(owner))
          .send(profile(sourceId));

        expect(res.status).toBe(202);
        expect((await repos.jobs.findById(first))?.error?.code).toBe('WORKER_LOST');
      });

      it('validates the payload', async () => {
        await addSource();
        const cases = [
          { payload: {}, field: 'body.payload.sourceId' },
          { payload: { sourceId: '../../etc/passwd' }, field: 'body.payload.sourceId' },
          {
            payload: { sourceId: 'a'.repeat(24), projectId: 'b'.repeat(24) },
            field: 'body.payload',
          },
        ];
        for (const { payload, field } of cases) {
          const res = await post({ type: 'profile', payload });
          expect(res.status).toBe(400);
          expect(res.body.error.code).toBe('VALIDATION_ERROR');
          expect((res.body.error.details as { field: string }[]).map((d) => d.field)).toContain(
            field,
          );
        }
        expect(ai.enqueued).toEqual([]);
      });

      it('lets data_engineer members and admins start it; viewers 403, outsiders 404, anonymous 401', async () => {
        const sourceId = await addSource();
        const engineer = await memberWith('data_engineer');
        const viewer = await memberWith('viewer');
        const steward = await memberWith('data_steward');
        const outsider = await register('outsider@example.com');

        expect((await post(profile(sourceId), viewer)).status).toBe(403);
        expect((await post(profile(sourceId), steward)).status).toBe(403);
        expect((await post(profile(sourceId), outsider)).status).toBe(404);
        await request(app)
          .post(`/api/v1/projects/${projectId}/jobs`)
          .send(profile(sourceId))
          .expect(401);
        expect((await post(profile(sourceId), engineer)).status).toBe(202);
        expect(ai.enqueued).toHaveLength(1);
      });
    });

    describe('GET /jobs/:jobId and GET /projects/:projectId/jobs', () => {
      it('returns a job to any project member and 404 to everyone else', async () => {
        const jobId = await startJob();
        const viewer = await memberWith('viewer');
        const outsider = await register('outsider@example.com');

        const res = await request(app).get(`/api/v1/jobs/${jobId}`).set(bearer(viewer));
        expect(res.status).toBe(200);
        expect(res.body.data.job).toMatchObject({ id: jobId, status: 'queued' });

        const hidden = await request(app).get(`/api/v1/jobs/${jobId}`).set(bearer(outsider));
        const missing = await request(app)
          .get('/api/v1/jobs/0123456789abcdef01234567')
          .set(bearer(owner));
        expect(hidden.status).toBe(404);
        expect(hidden.body).toEqual(missing.body);
        await request(app).get('/api/v1/jobs/not-an-id').set(bearer(owner)).expect(400);
        await request(app).get(`/api/v1/jobs/${jobId}`).expect(401);
      });

      it('lists recent jobs newest first, with a limit', async () => {
        const first = await startJob();
        const second = await startJob();
        const third = await startJob();
        const viewer = await memberWith('viewer');

        const all = await request(app)
          .get(`/api/v1/projects/${projectId}/jobs`)
          .set(bearer(viewer));
        expect(all.status).toBe(200);
        expect(all.body.data.items.map((j: { id: string }) => j.id)).toEqual([
          third,
          second,
          first,
        ]);

        const two = await request(app)
          .get(`/api/v1/projects/${projectId}/jobs?limit=2`)
          .set(bearer(owner));
        expect(two.body.data.items).toHaveLength(2);
        await request(app)
          .get(`/api/v1/projects/${projectId}/jobs?limit=101`)
          .set(bearer(owner))
          .expect(400);
        const outsider = await register('outsider@example.com');
        await request(app)
          .get(`/api/v1/projects/${projectId}/jobs`)
          .set(bearer(outsider))
          .expect(404);
        await request(app).get(`/api/v1/projects/${projectId}/jobs`).expect(401);
      });

      it('reports a running job with an old heartbeat as failed WORKER_LOST', async () => {
        const app2 = appWith({ JOB_STALE_AFTER_SECONDS: '60' });
        const stale = await startJob();
        const fresh = await startJob();
        const old = new Date(Date.now() - 61_000);
        await harness.workerUpdate(repos, stale, {
          status: 'running',
          attempts: 1,
          progress: 40,
          startedAt: old,
          heartbeatAt: old,
        });
        await harness.workerUpdate(repos, fresh, {
          status: 'running',
          attempts: 1,
          startedAt: old,
          heartbeatAt: new Date(),
        });

        const res = await request(app2).get(`/api/v1/jobs/${stale}`).set(bearer(owner));
        expect(res.body.data.job).toMatchObject({
          status: 'failed',
          progress: 40,
          error: { code: 'WORKER_LOST' },
        });
        expect((await repos.jobs.findById(stale))?.status).toBe('failed');
        expect(events.published.map((p) => p.jobId)).toEqual([stale]);

        const list = await request(app2)
          .get(`/api/v1/projects/${projectId}/jobs`)
          .set(bearer(owner));
        const statuses = Object.fromEntries(
          (list.body.data.items as { id: string; status: string }[]).map((j) => [j.id, j.status]),
        );
        expect(statuses).toEqual({ [stale]: 'failed', [fresh]: 'running' });
      });

      it('deletes a project’s jobs with the project', async () => {
        const jobId = await startJob();
        await request(app).delete(`/api/v1/projects/${projectId}`).set(bearer(owner)).expect(204);

        expect(await repos.jobs.findById(jobId)).toBeNull();
      });
    });

    describe('POST /jobs/:jobId/cancel', () => {
      it('cancels an active job, publishes it and tells the ai-service', async () => {
        const jobId = await startJob();
        await harness.workerUpdate(repos, jobId, { status: 'running', attempts: 1, progress: 33 });

        const res = await request(app)
          .post(`/api/v1/jobs/${jobId}/cancel`)
          .set(bearer(owner))
          .set('X-Request-Id', 'req-cancel-1');

        expect(res.status).toBe(200);
        expect(res.body.data.job).toMatchObject({ status: 'cancelled', progress: 33 });
        expect(res.body.data.job.finishedAt).toEqual(expect.any(String));
        expect(ai.cancelled).toEqual([{ jobId, requestId: 'req-cancel-1' }]);
        expect(events.published.at(-1)).toEqual({
          jobId,
          update: expect.objectContaining({ status: 'cancelled', progress: 33 }) as unknown,
        });
        const audit = await repos.audit.listByProject(projectId, { skip: 0, limit: 1 });
        expect(audit.items[0]).toMatchObject({ action: 'job.cancel', entityId: jobId });
      });

      it('leaves a finished job unchanged', async () => {
        const jobId = await startJob();
        await harness.workerUpdate(repos, jobId, {
          status: 'succeeded',
          progress: 100,
          result: { steps: 3 },
        });

        const res = await request(app).post(`/api/v1/jobs/${jobId}/cancel`).set(bearer(owner));

        expect(res.status).toBe(200);
        expect(res.body.data.job).toMatchObject({ status: 'succeeded', result: { steps: 3 } });
        expect(ai.cancelled).toEqual([]);
        expect(events.published).toEqual([]);
      });

      it('still cancels when the ai-service cannot be reached', async () => {
        const jobId = await startJob();
        ai.down = true;

        const res = await request(app).post(`/api/v1/jobs/${jobId}/cancel`).set(bearer(owner));

        expect(res.body.data.job.status).toBe('cancelled');
      });

      it('needs write access: viewers 403, non-members 404, anonymous 401', async () => {
        const jobId = await startJob();
        const viewer = await memberWith('viewer');
        const outsider = await register('outsider@example.com');

        await request(app).post(`/api/v1/jobs/${jobId}/cancel`).set(bearer(viewer)).expect(403);
        await request(app).post(`/api/v1/jobs/${jobId}/cancel`).set(bearer(outsider)).expect(404);
        await request(app).post(`/api/v1/jobs/${jobId}/cancel`).expect(401);
        expect((await repos.jobs.findById(jobId))?.status).toBe('queued');
      });
    });

    describe('GET /jobs/:jobId/events (Server-Sent Events)', () => {
      it('sends the current state at once, forwards updates and ends after a terminal one', async () => {
        const jobId = await startJob();
        const client = await stream(jobId);

        expect(client.response.status).toBe(200);
        expect(client.response.headers.get('content-type')).toBe(
          'text/event-stream; charset=utf-8',
        );
        expect(client.response.headers.get('cache-control')).toBe('no-cache, no-transform');
        expect(client.response.headers.get('x-accel-buffering')).toBe('no');
        expect(await client.next()).toEqual({
          event: 'job',
          data: {
            jobId,
            status: 'queued',
            progress: 0,
            message: 'Waiting to start',
            result: null,
            error: null,
          },
        });

        await eventually(() => events.listenerCount(jobId) === 1);
        events.emit(jobId, { status: 'running', progress: 50, message: 'Step 1 of 2 done' });
        expect((await client.next())?.data).toMatchObject({ status: 'running', progress: 50 });
        events.emit(jobId, {
          status: 'succeeded',
          progress: 100,
          message: 'Done',
          result: { steps: 2 },
        });
        expect((await client.next())?.data).toMatchObject({
          status: 'succeeded',
          result: { steps: 2 },
          error: null,
        });
        expect(await client.next()).toBeNull();
        await eventually(() => events.listenerCount(jobId) === 0);
      });

      it('ends at once for a job that has already finished', async () => {
        const jobId = await startJob();
        await harness.workerUpdate(repos, jobId, {
          status: 'failed',
          error: { code: 'DEMO_STEP_FAILED', message: 'Failed at step 2' },
        });
        const client = await stream(jobId);

        const frames = await client.rest();
        expect(frames.map((f) => f.data.status)).toEqual(['failed']);
        expect(frames[0]?.data.error).toEqual({
          code: 'DEMO_STEP_FAILED',
          message: 'Failed at step 2',
        });
        expect(events.listenerCount(jobId)).toBe(0);
      });

      it('sends keep-alive comments and re-reads the job, catching missed updates', async () => {
        const fast = appWith({ JOB_EVENTS_KEEPALIVE_MS: '30' });
        const jobId = await startJob();
        const client = await stream(jobId, owner, fast);
        await client.next();

        // The worker saved a change but its Redis message never arrived.
        await harness.workerUpdate(repos, jobId, { status: 'succeeded', progress: 100 });

        expect((await client.next())?.data).toMatchObject({ status: 'succeeded' });
        expect(client.comments).toContain('keep-alive');
        expect(await client.next()).toBeNull();
      });

      it('still works by re-reading when live updates are unavailable', async () => {
        events.failSubscribe = true;
        const fast = appWith({ JOB_EVENTS_KEEPALIVE_MS: '30' });
        const jobId = await startJob();
        const client = await stream(jobId, owner, fast);

        expect((await client.next())?.data.status).toBe('queued');
        await harness.workerUpdate(repos, jobId, {
          status: 'running',
          progress: 10,
          message: 'Go',
        });
        expect((await client.next())?.data).toMatchObject({ status: 'running', progress: 10 });
      });

      it('drops the subscription when the client disconnects', async () => {
        const jobId = await startJob();
        const client = await stream(jobId);
        await client.next();
        await eventually(() => events.listenerCount(jobId) === 1);

        client.close();

        await eventually(() => events.listenerCount(jobId) === 0);
      });

      it('answers 404 to non-members, 401 without a token and 400 for a bad id', async () => {
        const jobId = await startJob();
        const outsider = await register('outsider@example.com');

        const hidden = await request(app).get(`/api/v1/jobs/${jobId}/events`).set(bearer(outsider));
        expect(hidden.status).toBe(404);
        expect(hidden.body.error.code).toBe('NOT_FOUND');
        const anonymous = await request(app).get(`/api/v1/jobs/${jobId}/events`);
        expect(anonymous.status).toBe(401);
        expect(anonymous.headers['content-type']).toMatch(/application\/json/);
        await request(app).get('/api/v1/jobs/x/events').set(bearer(owner)).expect(400);
        expect(events.listenerCount(jobId)).toBe(0);
      });
    });
  });
}
