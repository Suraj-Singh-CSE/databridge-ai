import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { Logger } from '../src/logger.js';
import {
  createCounterStore,
  createMemoryCounters,
  createRedisCounters,
  createSharedCounters,
  withFallback,
  type CounterBackend,
} from '../src/rate-limit-store.js';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';

function fakeLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn() } as unknown as Logger & { warn: ReturnType<typeof vi.fn> };
}

/** A backend whose every call fails, as Redis does while it is unreachable. */
function down(): CounterBackend {
  const fail = () => Promise.reject(new Error('Connection is closed.'));
  return { hit: fail, decrement: fail, reset: fail, take: fail, close: () => Promise.resolve() };
}

/** One api "process": an app whose sign-in route is limited through `counters`. */
function apiProcess(counters: CounterBackend) {
  const app = express();
  app.post(
    '/login',
    rateLimit({
      windowMs: 60_000,
      limit: 2,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      store: createCounterStore(counters, 'auth:credentials:'),
      keyGenerator: () => 'client-1',
    }),
    (_req, res) => {
      res.json({ data: { ok: true }, error: null });
    },
  );
  return app;
}

describe('memory counters', () => {
  it('count a fixed window, decrement and reset', async () => {
    let now = 0;
    const counters = createMemoryCounters(() => now);
    expect(await counters.hit('k', 1000)).toEqual({ hits: 1, resetMs: 1000 });
    now = 400;
    expect(await counters.hit('k', 1000)).toEqual({ hits: 2, resetMs: 600 });
    await counters.decrement('k');
    expect((await counters.hit('k', 1000)).hits).toBe(2);
    await counters.reset('k');
    expect((await counters.hit('k', 1000)).hits).toBe(1);
    now = 1500;
    expect((await counters.hit('k', 1000)).hits).toBe(1);
    await counters.decrement('missing');
    await counters.close();
  });
});

describe('shared rate-limit store', () => {
  it('two api processes on one store share the sign-in limit', async () => {
    const shared = createMemoryCounters();
    const first = apiProcess(shared);
    const second = apiProcess(shared);

    expect((await request(first).post('/login')).status).toBe(200);
    expect((await request(second).post('/login')).status).toBe(200);
    expect((await request(first).post('/login')).status).toBe(429);
    expect((await request(second).post('/login')).status).toBe(429);
  });

  it('falls back to memory with one warning while the store is down', async () => {
    const logger = fakeLogger();
    let now = 0;
    const counters = withFallback(down(), createMemoryCounters(), logger, () => now);
    const app = apiProcess(counters);

    expect((await request(app).post('/login')).status).toBe(200);
    expect((await request(app).post('/login')).status).toBe(200);
    expect((await request(app).post('/login')).status).toBe(429); // still limited
    expect(await counters.take('assistant:u1', 1, 60_000)).toBe(true);
    expect(await counters.take('assistant:u1', 1, 60_000)).toBe(false);
    await counters.reset('x');
    await counters.decrement('x');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    now = 60_000;
    await counters.hit('y', 1000);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ operation: 'hit', errorType: 'Error' });
    await counters.close();
  });

  it('a Redis-backed store with Redis down still answers (memory)', async () => {
    const logger = fakeLogger();
    const counters = createSharedCounters('redis://127.0.0.1:1/0', logger);
    expect((await counters.hit('k', 1000)).hits).toBe(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    await counters.close();
  });
});

/** Skips locally when Redis is unreachable; in CI (CI=true) that is a failure instead. */
async function redisAvailable(): Promise<boolean> {
  const probe = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0 });
  probe.on('error', () => undefined);
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch (error) {
    if (process.env.CI === 'true') {
      throw new Error(`Redis is required in CI but ${REDIS_URL} is unreachable`, { cause: error });
    }
    process.stderr.write(`\n[skip] Redis rate-limit tests skipped: ${REDIS_URL} unreachable.\n`);
    return false;
  } finally {
    probe.disconnect();
  }
}

const available = await redisAvailable();

describe.skipIf(!available)('Redis counters (real Redis)', () => {
  const clients: Redis[] = [];
  function counters(now?: () => number): CounterBackend {
    const client = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
    clients.push(client);
    return createRedisCounters(client, now);
  }
  const suffix = `${String(process.pid)}:${String(Date.now())}`;

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.quit()));
  });

  it('count a fixed window atomically across processes', async () => {
    const a = counters();
    const b = counters();
    const key = `test:fixed:${suffix}`;
    const hits = await Promise.all([a.hit(key, 5000), b.hit(key, 5000), a.hit(key, 5000)]);
    expect(hits.map((h) => h.hits).sort()).toEqual([1, 2, 3]);
    expect(hits[0].resetMs).toBeGreaterThan(4000);
    await b.decrement(key);
    expect((await a.hit(key, 5000)).hits).toBe(3);
    await a.reset(key);
    expect((await b.hit(key, 5000)).hits).toBe(1);
  });

  it('share a sliding window of questions', async () => {
    let now = 1_000_000;
    const a = counters(() => now);
    const b = counters(() => now);
    const key = `test:sliding:${suffix}`;
    expect(await a.take(key, 2, 60_000)).toBe(true);
    expect(await b.take(key, 2, 60_000)).toBe(true);
    expect(await a.take(key, 2, 60_000)).toBe(false);
    now += 60_001;
    expect(await b.take(key, 2, 60_000)).toBe(true);
  });
});
