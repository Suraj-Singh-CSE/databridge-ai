import type { AiServiceClient, EnqueueJobInput } from '../../src/ai-service.client.js';
import { AiServiceError } from '../../src/ai-service.client.js';
import type {
  JobEventBus,
  JobUpdate,
  JobUpdateListener,
} from '../../src/modules/jobs/job.events.js';

/** Records calls; set `down = true` to make every call fail like an unreachable ai-service. */
export class FakeAiService implements AiServiceClient {
  readonly enqueued: { input: EnqueueJobInput; requestId: string }[] = [];
  readonly cancelled: { jobId: string; requestId: string }[] = [];
  down = false;

  async enqueueJob(input: EnqueueJobInput, requestId: string): Promise<void> {
    await Promise.resolve();
    if (this.down) throw new AiServiceError('ai-service answered 503', 503);
    this.enqueued.push({ input, requestId });
  }

  async cancelJob(jobId: string, requestId: string): Promise<void> {
    await Promise.resolve();
    if (this.down) throw new AiServiceError('ai-service unreachable');
    this.cancelled.push({ jobId, requestId });
  }
}

/** In-process event bus with the same contract as the Redis one. */
export class MemoryJobEventBus implements JobEventBus {
  readonly published: { jobId: string; update: JobUpdate }[] = [];
  /** Makes subscribe() reject, like Redis being down. */
  failSubscribe = false;
  private readonly listeners = new Map<string, Set<JobUpdateListener>>();

  listenerCount(jobId: string): number {
    return this.listeners.get(jobId)?.size ?? 0;
  }

  /** Delivers an update to subscribers without recording it (what the worker does). */
  emit(jobId: string, update: JobUpdate): void {
    for (const listener of this.listeners.get(jobId) ?? []) listener(update);
  }

  async subscribe(jobId: string, listener: JobUpdateListener): Promise<() => void> {
    await Promise.resolve();
    if (this.failSubscribe) throw new Error('redis down');
    const set = this.listeners.get(jobId) ?? new Set();
    set.add(listener);
    this.listeners.set(jobId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(jobId);
    };
  }

  async publish(jobId: string, update: JobUpdate): Promise<void> {
    await Promise.resolve();
    this.published.push({ jobId, update });
    this.emit(jobId, update);
  }

  async close(): Promise<void> {
    await Promise.resolve();
    this.listeners.clear();
  }
}
