import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '../src/logger.js';
import {
  createRedisJobEventBus,
  jobChannel,
  type JobEventBus,
  type JobUpdate,
} from '../src/modules/jobs/job.events.js';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';
const logger = createLogger({ NODE_ENV: 'test' });

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
    process.stderr.write(
      `\n[skip] Redis-backed job event tests skipped: ${REDIS_URL} unreachable.\n`,
    );
    return false;
  } finally {
    probe.disconnect();
  }
}

const available = await redisAvailable();

async function eventually(check: () => Promise<boolean> | boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe.skipIf(!available)('Redis job event bus', () => {
  let bus: JobEventBus;
  let raw: Redis;

  beforeAll(() => {
    bus = createRedisJobEventBus(REDIS_URL, logger);
    raw = new Redis(REDIS_URL);
  });

  afterAll(async () => {
    await bus.close();
    raw.disconnect();
  });

  async function subscribers(jobId: string): Promise<number> {
    const reply = (await raw.call('PUBSUB', 'NUMSUB', jobChannel(jobId))) as [string, unknown];
    return Number(reply[1]);
  }

  it('shares one Redis subscription per job and fans messages out', async () => {
    const jobId = 'a'.repeat(24);
    const first: JobUpdate[] = [];
    const second: JobUpdate[] = [];
    const stopFirst = await bus.subscribe(jobId, (u) => first.push(u));
    const stopSecond = await bus.subscribe(jobId, (u) => second.push(u));
    expect(await subscribers(jobId)).toBe(1);

    // Exactly what the Python worker publishes.
    await raw.publish(jobChannel(jobId), '{"status":"running","progress":50,"message":"Half"}');
    await raw.publish(jobChannel(jobId), 'not json');
    await raw.publish(jobChannel(jobId), '{"status":"exploded","progress":1,"message":"x"}');
    await raw.publish(
      jobChannel(jobId),
      '{"status":"failed","progress":50,"message":"Broke","error":{"code":"X_FAILED","message":"Broke"}}',
    );
    await eventually(() => second.length === 2);

    const expected = [
      { status: 'running', progress: 50, message: 'Half' },
      {
        status: 'failed',
        progress: 50,
        message: 'Broke',
        error: { code: 'X_FAILED', message: 'Broke' },
      },
    ];
    expect(first).toEqual(expected);
    expect(second).toEqual(expected);

    stopFirst();
    expect(await subscribers(jobId)).toBe(1);
    stopSecond();
    stopSecond();
    await eventually(async () => (await subscribers(jobId)) === 0);
  });

  it('subscribes again after the last listener left', async () => {
    const jobId = 'b'.repeat(24);
    const stop = await bus.subscribe(jobId, () => undefined);
    stop();
    const received: JobUpdate[] = [];
    const again = await bus.subscribe(jobId, (u) => received.push(u));

    await bus.publish(jobId, { status: 'queued', progress: 0, message: 'Waiting' });

    await eventually(() => received.length === 1);
    again();
  });

  it('publishes updates as JSON on jobs:<jobId>', async () => {
    const jobId = 'c'.repeat(24);
    const listener = new Redis(REDIS_URL);
    const messages: string[] = [];
    listener.on('message', (_channel: string, message: string) => messages.push(message));
    await listener.subscribe(jobChannel(jobId));

    await bus.publish(jobId, { status: 'cancelled', progress: 10, message: 'Cancelled' });

    await eventually(() => messages.length === 1);
    expect(JSON.parse(messages[0] ?? '')).toEqual({
      status: 'cancelled',
      progress: 10,
      message: 'Cancelled',
    });
    listener.disconnect();
  });
});

describe('Redis job event bus without Redis', () => {
  it('rejects subscribe instead of hanging', async () => {
    const bus = createRedisJobEventBus('redis://127.0.0.1:1/0', logger);

    await expect(bus.subscribe('d'.repeat(24), () => undefined)).rejects.toThrow();
    await expect(
      bus.publish('d'.repeat(24), { status: 'queued', progress: 0, message: 'x' }),
    ).rejects.toThrow();
    await bus.close();
  }, 10_000);
});
