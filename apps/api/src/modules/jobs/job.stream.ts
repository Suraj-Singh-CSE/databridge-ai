import type { Response } from 'express';

import type { Logger } from '../../logger.js';

import type { JobEventBus, JobUpdate } from './job.events.js';
import { toUpdate } from './job.service.js';
import { isTerminal, type Job, type JobStatus } from './job.types.js';

export interface JobStreamDeps {
  events: JobEventBus;
  /** Re-reads the job (stale rule included). */
  reload: () => Promise<Job | null>;
  keepAliveMs: number;
  logger: Pick<Logger, 'warn'>;
}

/** One SSE frame: `event: job` with `{ jobId, status, progress, message, result, error }`. */
interface Frame extends JobUpdate {
  jobId: string;
}

const STAGE: Record<JobStatus, number> = {
  queued: 0,
  running: 1,
  succeeded: 2,
  failed: 2,
  cancelled: 2,
};

/** True when `update` describes an earlier point than `current` (an update sent before it). */
export function isBehind(update: JobUpdate, current: JobUpdate): boolean {
  const stage = STAGE[update.status] - STAGE[current.status];
  return stage < 0 || (stage === 0 && update.progress < current.progress);
}

/**
 * Server-Sent Events for one job. Order of work avoids a gap: subscribe first, then read the
 * current state and send it, then forward updates (those that arrived in between are sent
 * unless older than that state). A `: keep-alive` comment goes out every keepAliveMs together
 * with a re-read of the job, which also delivers changes whose Redis message was lost. The
 * stream ends after a terminal status; a client disconnect releases the subscription.
 */
export async function streamJob(
  res: Response,
  job: Job,
  { events, reload, keepAliveMs, logger }: JobStreamDeps,
): Promise<void> {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Tells nginx not to buffer this response (infra/nginx.conf also turns buffering off).
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Mutable state shared by the callbacks below.
  const stream: {
    closed: boolean;
    ready: boolean;
    last: Frame | null;
    unsubscribe: (() => void) | null;
    timer: NodeJS.Timeout | undefined;
  } = { closed: false, ready: false, last: null, unsubscribe: null, timer: undefined };
  const early: JobUpdate[] = [];

  const close = (): void => {
    if (stream.closed) return;
    stream.closed = true;
    clearInterval(stream.timer);
    stream.unsubscribe?.();
    res.end();
  };
  res.on('close', close);

  const send = (update: JobUpdate): void => {
    if (stream.closed) return;
    const frame: Frame = {
      jobId: job.id,
      status: update.status,
      progress: update.progress,
      message: update.message,
      result: update.result ?? null,
      error: update.error ?? null,
    };
    const { last } = stream;
    if (
      last?.status === frame.status &&
      last.progress === frame.progress &&
      last.message === frame.message
    ) {
      return;
    }
    res.write(`event: job\ndata: ${JSON.stringify(frame)}\n\n`);
    stream.last = frame;
    if (isTerminal(frame.status)) close();
  };

  try {
    stream.unsubscribe = await events.subscribe(job.id, (update) => {
      if (stream.ready) send(update);
      else early.push(update);
    });
  } catch (error) {
    logger.warn(
      { jobId: job.id, err: String(error) },
      'live job updates unavailable; the stream falls back to re-reading on keep-alive',
    );
  }
  if (stream.closed) {
    // The client left while subscribing.
    stream.unsubscribe?.();
    return;
  }

  const current = toUpdate((await reload()) ?? job);
  send(current);
  stream.ready = true;
  for (const update of early) if (!isBehind(update, current)) send(update);
  early.length = 0;
  // Already terminal: the stream has ended.
  if (res.writableEnded) return;

  stream.timer = setInterval(() => {
    if (stream.closed) return;
    res.write(': keep-alive\n\n');
    reload().then(
      (latest) => {
        if (latest) send(toUpdate(latest));
      },
      (error: unknown) => {
        logger.warn({ jobId: job.id, err: String(error) }, 'job re-read failed');
      },
    );
  }, keepAliveMs);
}
