import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { buildTestApp } from './support/build-app.js';
import { MemoryJobEventBus } from './support/fakes.js';

describe('GET /api/v1/health', () => {
  it('returns ok in the standard envelope', async () => {
    const res = await request(buildTestApp()).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { status: 'ok', service: 'api' }, error: null });
  });

  it('echoes a valid incoming request id', async () => {
    const res = await request(buildTestApp()).get('/api/v1/health').set('X-Request-Id', 'abc-123');

    expect(res.headers['x-request-id']).toBe('abc-123');
  });

  it('replaces an unsafe incoming request id', async () => {
    const res = await request(buildTestApp())
      .get('/api/v1/health')
      .set('X-Request-Id', 'bad id<script>');

    expect(res.headers['x-request-id']).toMatch(/^[\da-f-]{36}$/);
  });
});

describe('GET /api/v1/ready', () => {
  it('answers 200 with every check ok', async () => {
    const app = buildTestApp({
      readiness: { mongodb: () => Promise.resolve('pong'), redis: () => Promise.resolve(1) },
    });
    const res = await request(app).get('/api/v1/ready');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: { status: 'ready', checks: { mongodb: 'ok', redis: 'ok' } },
      error: null,
    });
  });

  it('answers 503 naming the unavailable dependency, without its error details', async () => {
    const app = buildTestApp({
      readiness: {
        mongodb: () => Promise.reject(new Error('mongodb://user:secret@host refused')),
        redis: () => new Promise(() => undefined), // hangs: times out
      },
    });
    const res = await request(app).get('/api/v1/ready');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      data: null,
      error: {
        code: 'NOT_READY',
        message: 'A dependency is unavailable.',
        details: { checks: { mongodb: 'unavailable', redis: 'unavailable' } },
      },
    });
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  it('checks MongoDB and the Redis event bus by default', async () => {
    const events = new MemoryJobEventBus();
    events.failPing = true;
    const res = await request(buildTestApp({ jobEvents: events })).get('/api/v1/ready');

    expect(res.status).toBe(503);
    // MongoDB is not connected in this test; Redis (the bus) refuses its ping.
    expect(res.body.error.details.checks).toEqual({ mongodb: 'unavailable', redis: 'unavailable' });
  });
});

describe('unknown routes', () => {
  it('return NOT_FOUND in the error envelope', async () => {
    const res = await request(buildTestApp()).get('/api/v1/nope');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      data: null,
      error: { code: 'NOT_FOUND', message: 'Route not found.', details: null },
    });
  });
});
