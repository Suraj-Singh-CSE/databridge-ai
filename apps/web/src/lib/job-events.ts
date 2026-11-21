/**
 * Live progress of a background job. GET /jobs/:jobId/events is Server-Sent Events behind the
 * usual bearer token, and EventSource cannot send an Authorization header, so the stream is read
 * with fetch() streaming and parsed here. If the stream fails (proxy timeout, network blip), the
 * job is re-read with GET /jobs/:jobId and the stream is opened again; after repeated failures the
 * watcher falls back to polling. See ADR 0007 ("Uploads and live job progress").
 */
import { api, ApiError, authorizedGet, errorFromResponse } from '@/lib/api';
import type { Job, JobStatus, JobUpdate } from '@/lib/api-types';

export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Incremental parser for `text/event-stream`. Feed it decoded text as it arrives; it returns the
 * events completed by that chunk. Comments (`: keep-alive`) are skipped; multi-line `data` is
 * joined with "\n"; the event name defaults to "message".
 */
export class SseParser {
  private buffer = '';

  push(chunk: string): SseEvent[] {
    this.buffer += chunk.replace(/\r\n?/g, '\n');
    const events: SseEvent[] = [];
    let end = this.buffer.indexOf('\n\n');
    while (end !== -1) {
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      const event = parseBlock(block);
      if (event) events.push(event);
      end = this.buffer.indexOf('\n\n');
    }
    return events;
  }
}

function parseBlock(block: string): SseEvent | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length > 0 ? { event, data: data.join('\n') } : null;
}

const STATUSES: readonly JobStatus[] = ['queued', 'running', 'succeeded', 'failed', 'cancelled'];

export function isTerminalStatus(status: JobStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The `data` of an `event: job` frame, or null when it is not a valid update. */
export function parseJobUpdate(data: string): JobUpdate | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    typeof value.jobId !== 'string' ||
    typeof value.status !== 'string' ||
    !(STATUSES as readonly string[]).includes(value.status) ||
    typeof value.progress !== 'number' ||
    typeof value.message !== 'string'
  ) {
    return null;
  }
  const error = isRecord(value.error) ? value.error : null;
  return {
    jobId: value.jobId,
    status: value.status as JobStatus,
    progress: value.progress,
    message: value.message,
    result: isRecord(value.result) ? value.result : null,
    error:
      error && typeof error.code === 'string' && typeof error.message === 'string'
        ? { code: error.code, message: error.message }
        : null,
  };
}

export function updateFromJob(job: Job): JobUpdate {
  return {
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    result: job.result,
    error: job.error,
  };
}

export interface WatchJobOptions {
  onUpdate: (update: JobUpdate) => void;
  signal: AbortSignal;
  /** Delay before re-opening a broken stream and between polls (ms). */
  retryMs?: number;
  /** Stream failures in a row before switching to polling only. */
  maxStreamFailures?: number;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 4xx answers (not found, forbidden, signed out) will not get better by retrying. */
function isFinal(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500;
}

/** Reads one SSE connection. Resolves with the terminal update, or null if the stream ended early. */
async function readStream(
  jobId: string,
  onUpdate: (update: JobUpdate) => void,
  signal: AbortSignal,
): Promise<JobUpdate | null> {
  const response = await authorizedGet(`/jobs/${encodeURIComponent(jobId)}/events`, signal);
  if (!response.ok) throw await errorFromResponse(response);
  if (!response.body) throw new ApiError(0, 'NETWORK_ERROR', 'Live updates are not available.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return null;
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        if (event.event !== 'job') continue;
        const update = parseJobUpdate(event.data);
        if (!update) continue;
        onUpdate(update);
        if (isTerminalStatus(update.status)) return update;
      }
    }
  } finally {
    // Closes the connection when we stop early (terminal update, abort or parse error).
    reader.cancel().catch(() => undefined);
  }
}

async function poll(jobId: string, signal: AbortSignal): Promise<JobUpdate> {
  const { job } = await api<{ job: Job }>(`/jobs/${encodeURIComponent(jobId)}`, { signal });
  return updateFromJob(job);
}

/**
 * Follows a job until it ends and resolves with its last update. Rejects with an AbortError when
 * `signal` aborts, or with ApiError on a 4xx (e.g. the job is not visible to this user).
 */
export async function watchJob(jobId: string, options: WatchJobOptions): Promise<JobUpdate> {
  const { onUpdate, signal, retryMs = 2000, maxStreamFailures = 3 } = options;
  let failures = 0;
  for (;;) {
    if (failures < maxStreamFailures) {
      try {
        const final = await readStream(jobId, onUpdate, signal);
        if (final) return final;
        failures = 0; // a clean end without a final status: reconnect straight away
      } catch (error) {
        if (signal.aborted || isFinal(error)) throw error;
        failures += 1;
      }
    }
    // Between streams (and in polling mode): read the job so no change is missed.
    try {
      const latest = await poll(jobId, signal);
      onUpdate(latest);
      if (isTerminalStatus(latest.status)) return latest;
    } catch (error) {
      if (signal.aborted || isFinal(error)) throw error;
    }
    await sleep(retryMs, signal);
  }
}
