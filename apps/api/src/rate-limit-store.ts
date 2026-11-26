/**
 * Rate-limit counters shared by every api process through Redis (finding G3-09, ADR 0028), with
 * an in-memory fallback while Redis is unreachable. Used by the sign-in/registration and session
 * limiters (as an express-rate-limit store) and the assistant's per-user question limit.
 *
 * A small store of our own instead of the `rate-limit-redis` package: that package fails (or,
 * with `passOnStoreError`, lets everything through) when Redis is down; this one keeps limiting
 * per process.
 */
import { randomUUID } from 'node:crypto';

import type { ClientRateLimitInfo, Options, Store } from 'express-rate-limit';
import { Redis } from 'ioredis';

import type { Logger } from './logger.js';

export interface CounterBackend {
  /** Fixed window: counts one hit; returns the hits so far and the ms until the window ends. */
  hit(key: string, windowMs: number): Promise<{ hits: number; resetMs: number }>;
  decrement(key: string): Promise<void>;
  reset(key: string): Promise<void>;
  /** Sliding window: takes a slot unless `max` were taken in the last `windowMs`. */
  take(key: string, max: number, windowMs: number): Promise<boolean>;
  close(): Promise<void>;
}

/** This process only: the fallback, and the store for tests and RATE_LIMIT_STORE=memory. */
export function createMemoryCounters(now: () => number = Date.now): CounterBackend {
  const windows = new Map<string, { hits: number; resetAt: number }>();
  const slots = new Map<string, number[]>();
  return {
    hit(key, windowMs) {
      const at = now();
      let entry = windows.get(key);
      if (!entry || entry.resetAt <= at) {
        entry = { hits: 0, resetAt: at + windowMs };
        windows.set(key, entry);
      }
      entry.hits += 1;
      return Promise.resolve({ hits: entry.hits, resetMs: entry.resetAt - at });
    },
    decrement(key) {
      const entry = windows.get(key);
      if (entry && entry.hits > 0) entry.hits -= 1;
      return Promise.resolve();
    },
    reset(key) {
      windows.delete(key);
      return Promise.resolve();
    },
    take(key, max, windowMs) {
      const at = now();
      const recent = (slots.get(key) ?? []).filter((t) => at - t < windowMs);
      const allowed = recent.length < max;
      if (allowed) recent.push(at);
      slots.set(key, recent);
      return Promise.resolve(allowed);
    },
    close() {
      windows.clear();
      slots.clear();
      return Promise.resolve();
    },
  };
}

const HIT_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {hits, ttl}
`;

const DECREMENT_SCRIPT = `
local hits = tonumber(redis.call('GET', KEYS[1]) or '0')
if hits > 0 then redis.call('DECR', KEYS[1]) end
return 0
`;

const TAKE_SCRIPT = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[3]) then
  redis.call('ZADD', KEYS[1], now, ARGV[4])
  redis.call('PEXPIRE', KEYS[1], window)
  return 1
end
return 0
`;

/** The part of an ioredis client the counters use. */
export interface EvalClient {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  del(key: string): Promise<number>;
  quit(): Promise<unknown>;
}

const KEY_PREFIX = 'ratelimit:';

/** Atomic Lua counters in Redis; every api process sees the same counts. */
export function createRedisCounters(
  client: EvalClient,
  now: () => number = Date.now,
): CounterBackend {
  return {
    async hit(key, windowMs) {
      const [hits, ttl] = (await client.eval(HIT_SCRIPT, 1, KEY_PREFIX + key, windowMs)) as [
        unknown,
        unknown,
      ];
      return { hits: Number(hits), resetMs: Number(ttl) };
    },
    async decrement(key) {
      await client.eval(DECREMENT_SCRIPT, 1, KEY_PREFIX + key);
    },
    async reset(key) {
      await client.del(KEY_PREFIX + key);
    },
    async take(key, max, windowMs) {
      const at = now();
      const member = `${String(at)}:${randomUUID()}`; // unique across processes and hosts
      const taken = await client.eval(TAKE_SCRIPT, 1, KEY_PREFIX + key, at, windowMs, max, member);
      return Number(taken) === 1;
    },
    async close() {
      await client.quit();
    },
  };
}

/** How often "store unavailable" is logged while Redis stays down. */
const WARN_EVERY_MS = 60_000;

/** `primary` (Redis) while it answers, `fallback` (memory) while it fails, with a warning. */
export function withFallback(
  primary: CounterBackend,
  fallback: CounterBackend,
  logger: Logger,
  now: () => number = Date.now,
): CounterBackend {
  let lastWarning = Number.NEGATIVE_INFINITY;
  async function run<T>(
    operation: string,
    call: (backend: CounterBackend) => Promise<T>,
  ): Promise<T> {
    try {
      return await call(primary);
    } catch (error) {
      const at = now();
      if (at - lastWarning >= WARN_EVERY_MS) {
        lastWarning = at;
        logger.warn(
          { operation, errorType: error instanceof Error ? error.name : typeof error },
          'rate limit store unavailable: limiting per process',
        );
      }
      return call(fallback);
    }
  }
  return {
    hit: (key, windowMs) => run('hit', (b) => b.hit(key, windowMs)),
    decrement: (key) => run('decrement', (b) => b.decrement(key)),
    reset: (key) => run('reset', (b) => b.reset(key)),
    take: (key, max, windowMs) => run('take', (b) => b.take(key, max, windowMs)),
    async close() {
      await Promise.allSettled([primary.close(), fallback.close()]);
    },
  };
}

/** Redis command timeout: a Redis outage must not hang a sign-in. */
const COMMAND_TIMEOUT_MS = 1000;

/** The production counters: Redis at `redisUrl`, memory while it is down. */
export function createSharedCounters(redisUrl: string, logger: Logger): CounterBackend {
  const client = new Redis(redisUrl, {
    commandTimeout: COMMAND_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    // Fail at once while disconnected (and fall back) instead of queueing the command.
    enableOfflineQueue: false,
  });
  client.on('error', () => {
    // Reported by withFallback when a command fails; ioredis reconnects by itself.
  });
  return withFallback(createRedisCounters(client), createMemoryCounters(), logger);
}

/** An express-rate-limit store over `backend`; one per limiter (`prefix` keeps them apart). */
export function createCounterStore(backend: CounterBackend, prefix: string): Store {
  let windowMs = 60_000;
  return {
    prefix,
    localKeys: false,
    init(options: Options) {
      windowMs = options.windowMs;
    },
    async increment(key: string): Promise<ClientRateLimitInfo> {
      const { hits, resetMs } = await backend.hit(`${prefix}${key}`, windowMs);
      return { totalHits: hits, resetTime: new Date(Date.now() + resetMs) };
    },
    async decrement(key: string) {
      await backend.decrement(`${prefix}${key}`);
    },
    async resetKey(key: string) {
      await backend.reset(`${prefix}${key}`);
    },
  };
}
