import type {
  AiServiceClient,
  AskAssistantInput,
  AssistantAnswer,
  EnqueueJobInput,
} from '../../src/ai-service.client.js';
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
  readonly asked: { input: AskAssistantInput; requestId: string }[] = [];
  down = false;
  /** The ai-service's error code to fail `askAssistant` with (e.g. `KNOWLEDGE_NOT_BUILT`). */
  askError: { status: number; code: string } | null = null;
  /** What `askAssistant` answers; by default a grounded answer citing one quality chunk. */
  answer: (input: AskAssistantInput) => AssistantAnswer = () => ({
    answer: 'The PIN code rule failed because some customers have no PIN code [1].',
    citations: [
      {
        n: 1,
        chunkId: 'quality:q1:completeness_optional:pin_code',
        kind: 'quality',
        title: 'Quality rule Optional field filled in of pin_code: fail',
        link: { page: 'quality', params: { rule: 'completeness_optional:pin_code' } },
      },
    ],
    confidence: 'high',
    answerable: true,
    refusalReason: null,
    mode: 'hybrid',
    model: 'mock',
    latencyMs: 12,
    redactions: 0,
    invalidCitations: 0,
  });

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

  async askAssistant(input: AskAssistantInput, requestId: string): Promise<AssistantAnswer> {
    await Promise.resolve();
    if (this.down) throw new AiServiceError('ai-service unreachable');
    if (this.askError) {
      throw new AiServiceError('ai-service answered', this.askError.status, this.askError.code);
    }
    this.asked.push({ input: structuredClone(input), requestId });
    return this.answer(input);
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
