import { Redis } from 'ioredis';
import { z } from 'zod';

import type { Logger } from '../../logger.js';

import { JOB_STATUSES } from './job.types.js';

/** Live update for one job, as published on Redis channel `jobs:<jobId>` (by the worker too). */
export const jobUpdateSchema = z.object({
  status: z.enum(JOB_STATUSES),
  progress: z.int().min(0).max(100),
  message: z.string().max(500),
  result: z.record(z.string(), z.unknown()).nullish(),
  error: z.object({ code: z.string(), message: z.string() }).nullish(),
});
export type JobUpdate = z.infer<typeof jobUpdateSchema>;
export type JobUpdateListener = (update: JobUpdate) => void;

/** Same name as apps/ai-service/app/worker/keys.py. */
export const jobChannel = (jobId: string): string => `jobs:${jobId}`;

export interface JobEventBus {
  /** Resolves once updates for the job are being received; call the result to stop. */
  subscribe(jobId: string, listener: JobUpdateListener): Promise<() => void>;
  publish(jobId: string, update: JobUpdate): Promise<void>;
  close(): Promise<void>;
}

/** Redis command timeout: a Redis outage must not hang a request. */
const COMMAND_TIMEOUT_MS = 2000;

/**
 * One subscriber connection per api process, shared by every open event stream through an
 * in-process fan-out map (channel -> listeners). A channel is subscribed in Redis while at least
 * one listener wants it. Publishing needs a second connection: a subscribed one cannot publish.
 */
export function createRedisJobEventBus(redisUrl: string, logger: Logger): JobEventBus {
  const options = { commandTimeout: COMMAND_TIMEOUT_MS, maxRetriesPerRequest: 1 };
  const subscriber = new Redis(redisUrl, options);
  const publisher = new Redis(redisUrl, options);
  for (const [name, client] of [
    ['subscriber', subscriber],
    ['publisher', publisher],
  ] as const) {
    client.on('error', (error: Error) => {
      logger.warn({ connection: name, err: error.message }, 'redis job events connection error');
    });
  }

  const listeners = new Map<string, Set<JobUpdateListener>>();
  // Per-channel chain so SUBSCRIBE/UNSUBSCRIBE for one channel run in call order.
  const chains = new Map<string, Promise<unknown>>();

  function serial(channel: string, command: () => Promise<unknown>): Promise<unknown> {
    const previous = chains.get(channel) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(command);
    chains.set(channel, next);
    const forget = () => {
      if (chains.get(channel) === next) chains.delete(channel);
    };
    next.then(forget, forget);
    return next;
  }

  function remove(channel: string, listener: JobUpdateListener): void {
    const set = listeners.get(channel);
    if (!set?.delete(listener) || set.size > 0) return;
    listeners.delete(channel);
    serial(channel, () => subscriber.unsubscribe(channel)).catch((error: unknown) => {
      logger.warn({ channel, err: String(error) }, 'redis unsubscribe failed');
    });
  }

  subscriber.on('message', (channel: string, raw: string) => {
    const set = listeners.get(channel);
    if (!set) return;
    let update: JobUpdate;
    try {
      update = jobUpdateSchema.parse(JSON.parse(raw));
    } catch {
      logger.warn({ channel }, 'ignored an invalid job update message');
      return;
    }
    for (const listener of set) listener(update);
  });

  return {
    async subscribe(jobId, listener) {
      const channel = jobChannel(jobId);
      let set = listeners.get(channel);
      const first = !set;
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(listener);
      try {
        // The first listener subscribes; later ones wait for that subscription to be in place.
        await (first ? serial(channel, () => subscriber.subscribe(channel)) : chains.get(channel));
      } catch (error) {
        remove(channel, listener);
        throw error;
      }
      return () => {
        remove(channel, listener);
      };
    },
    async publish(jobId, update) {
      await publisher.publish(jobChannel(jobId), JSON.stringify(update));
    },
    async close() {
      listeners.clear();
      await Promise.allSettled([subscriber.quit(), publisher.quit()]);
    },
  };
}
