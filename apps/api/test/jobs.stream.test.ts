import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import type { JobUpdate, JobUpdateListener } from '../src/modules/jobs/job.events.js';
import { isBehind } from '../src/modules/jobs/job.stream.js';

import { buildTestApp } from './support/build-app.js';
import { MemoryJobEventBus } from './support/fakes.js';
import { createMemoryRepositories } from './support/memory-repositories.js';
import { listen, SseClient } from './support/sse-client.js';

const update = (status: JobUpdate['status'], progress: number): JobUpdate => ({
  status,
  progress,
  message: `${status} ${progress}`,
});

describe('isBehind', () => {
  it('orders by stage, then by progress within the same stage', () => {
    const running50 = update('running', 50);

    expect(isBehind(update('queued', 0), running50)).toBe(true);
    expect(isBehind(update('running', 40), running50)).toBe(true);
    expect(isBehind(update('running', 50), running50)).toBe(false);
    expect(isBehind(update('running', 60), running50)).toBe(false);
    expect(isBehind(update('succeeded', 100), running50)).toBe(false);
    expect(isBehind(update('running', 100), update('failed', 0))).toBe(true);
  });
});

/** Delivers updates while subscribe() is still pending, i.e. before the snapshot is read. */
class EarlyBus extends MemoryJobEventBus {
  constructor(private readonly early: JobUpdate[]) {
    super();
  }

  override async subscribe(jobId: string, listener: JobUpdateListener): Promise<() => void> {
    const stop = await super.subscribe(jobId, listener);
    for (const item of this.early) listener(item);
    return stop;
  }
}

let closeServer: (() => Promise<void>) | null = null;
afterEach(async () => {
  await closeServer?.();
  closeServer = null;
});

describe('job event stream ordering', () => {
  it('forwards updates that arrived before the snapshot only if they are newer', async () => {
    const repos = createMemoryRepositories();
    const events = new EarlyBus([
      update('queued', 0),
      update('running', 10),
      update('running', 20),
    ]);
    const app = buildTestApp({ repos, jobEvents: events });
    const register = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'o@example.com', name: 'O', password: 'correct horse battery' });
    const token = (register.body as { data: { accessToken: string } }).data.accessToken;
    const project = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'P' });
    const projectId = (project.body as { data: { project: { id: string } } }).data.project.id;
    const job = await request(app)
      .post(`/api/v1/projects/${projectId}/jobs`)
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'demo', payload: { steps: 2, stepMs: 10 } });
    const jobId = (job.body as { data: { job: { id: string } } }).data.job.id;
    // The snapshot read after subscribing already shows 10%.
    repos.jobs.workerUpdate(jobId, { status: 'running', progress: 10, message: 'running 10' });

    const server = await listen(app);
    closeServer = server.close;
    const client = await SseClient.open(`${server.url}/api/v1/jobs/${jobId}/events`, token);

    expect((await client.next())?.data).toMatchObject({ status: 'running', progress: 10 });
    expect((await client.next())?.data).toMatchObject({ status: 'running', progress: 20 });
    events.emit(jobId, update('cancelled', 20));
    expect((await client.next())?.data).toMatchObject({ status: 'cancelled' });
    expect(await client.next()).toBeNull();
  });
});
