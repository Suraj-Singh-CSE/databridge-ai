import { z } from 'zod';

import type { Config } from './config.js';

export interface EnqueueJobInput {
  jobId: string;
  projectId: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface AskAssistantInput {
  projectId: string;
  question: string;
  /** Earlier turns of the conversation, oldest first (the ai-service keeps the last few). */
  history: { question: string; answer: string }[];
}

export interface AssistantCitation {
  n: number;
  chunkId: string;
  kind: 'customer' | 'decision' | 'mapping' | 'quality' | 'sql' | 'docs';
  title: string;
  link: { page: string; params: Record<string, string> };
}

export type AssistantRefusalReason =
  | 'personal_data'
  | 'weak_retrieval'
  | 'not_answerable'
  | 'no_citation'
  /** The free tier's daily LLM request budget is used up (ADR 0028). */
  | 'daily_budget';

/** `POST /internal/v1/assistant/ask` (ADR 0025). */
export interface AssistantAnswer {
  answer: string;
  citations: AssistantCitation[];
  confidence: 'high' | 'medium' | 'low';
  answerable: boolean;
  refusalReason: AssistantRefusalReason | null;
  mode: 'hybrid' | 'keyword' | null;
  model: string | null;
  latencyMs: number;
  redactions: number;
  invalidCitations: number;
}

/** `GET /internal/v1/llm/budget` (ADR 0028): today's LLM request counts. Counts only. */
const aiBudgetSchema = z.object({
  provider: z.string(),
  model: z.string(),
  dailyLimit: z.int().min(0).nullable(),
  usedToday: z.int().min(0),
  projectDailyLimit: z.int().min(0).nullable(),
  projectUsedToday: z.int().min(0),
  /** Requests left today for the project (the smaller remainder); null when uncapped. */
  remainingToday: z.int().min(0).nullable(),
  resetsAt: z.string(),
});
export type AiBudget = z.infer<typeof aiBudgetSchema>;

/** Reading the budget must never hold up the dashboard (and never wakes a sleeping service). */
const BUDGET_TIMEOUT_MS = 3000;

/** The internal ai-service routes the api calls (`/internal/v1`, `X-Service-Token`). */
export interface AiServiceClient {
  enqueueJob(input: EnqueueJobInput, requestId: string): Promise<void>;
  cancelJob(jobId: string, requestId: string): Promise<void>;
  askAssistant(input: AskAssistantInput, requestId: string): Promise<AssistantAnswer>;
  /** Today's LLM budget for the project; null when the ai-service keeps none (mock provider). */
  aiBudget(projectId: string, requestId: string): Promise<AiBudget | null>;
}

/** The ai-service could not be reached, timed out, or answered with an error status. */
export class AiServiceError extends Error {
  override readonly name = 'AiServiceError';

  constructor(
    message: string,
    readonly status: number | null = null,
    /** The ai-service's error code (e.g. `KNOWLEDGE_NOT_BUILT`), when it sent one. */
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

type ClientConfig = Pick<Config, 'AI_SERVICE_URL' | 'AI_SERVICE_TOKEN' | 'AI_SERVICE_TIMEOUT_MS'> &
  Partial<Pick<Config, 'ASSISTANT_TIMEOUT_MS' | 'AI_SERVICE_WAKE_TIMEOUT_MS'>>;

/** The error code of a call refused because the ai-service did not wake up in time. */
export const AI_SERVICE_WAKING = 'AI_SERVICE_WAKING';

/** Injected in tests; real time otherwise. */
export interface ClientTiming {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** After an answer, the service is taken as awake for this long (free hosting sleeps after 15 min). */
const AWAKE_FOR_MS = 60_000;
/** One /health attempt may wait this long: a sleeping service answers once it has started. */
const WAKE_ATTEMPT_TIMEOUT_MS = 30_000;
const WAKE_BACKOFF_START_MS = 1000;
const WAKE_BACKOFF_MAX_MS = 8000;

export function createAiServiceClient(
  config: ClientConfig,
  { now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }: ClientTiming = {},
): AiServiceClient {
  const base = config.AI_SERVICE_URL.replace(/\/+$/, '');
  let awakeUntil = 0;

  function markAwake(): void {
    awakeUntil = now() + AWAKE_FOR_MS;
  }

  /**
   * Free web services sleep without traffic and take 30-60 s to start (ADR 0026). Before an
   * enqueue or a question, poll the open /health route with backoff until it answers or
   * AI_SERVICE_WAKE_TIMEOUT_MS passes; then fail with AI_SERVICE_WAKING. Skipped while the
   * service answered recently.
   */
  async function wake(requestId: string): Promise<void> {
    const limit = config.AI_SERVICE_WAKE_TIMEOUT_MS ?? 0;
    if (limit <= 0 || now() < awakeUntil) return;
    const deadline = now() + limit;
    let delay = WAKE_BACKOFF_START_MS;
    for (;;) {
      const remaining = deadline - now();
      if (remaining <= 0) break;
      try {
        const response = await fetch(`${base}/internal/v1/health`, {
          headers: { 'X-Request-ID': requestId },
          signal: AbortSignal.timeout(Math.min(remaining, WAKE_ATTEMPT_TIMEOUT_MS)),
        });
        await response.arrayBuffer().catch(() => undefined);
        if (response.ok) {
          markAwake();
          return;
        }
      } catch {
        // Not up yet (connection refused, proxy error or timeout): try again.
      }
      const wait = Math.min(delay, deadline - now());
      if (wait <= 0) break;
      await sleep(wait);
      delay = Math.min(delay * 2, WAKE_BACKOFF_MAX_MS);
    }
    throw new AiServiceError('ai-service did not wake up in time', 503, AI_SERVICE_WAKING);
  }

  async function send(
    path: string,
    body: unknown,
    requestId: string,
    timeoutMs: number,
  ): Promise<Response> {
    try {
      const response = await fetch(`${base}/internal/v1${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Token': config.AI_SERVICE_TOKEN,
          'X-Request-ID': requestId,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // A 5xx may come from the platform's proxy while the service starts: not proof it is up.
      if (response.status < 500) markAwake();
      return response;
    } catch (error) {
      throw new AiServiceError(`ai-service unreachable: ${String(error)}`);
    }
  }

  async function post(path: string, body: unknown, requestId: string): Promise<void> {
    const response = await send(path, body, requestId, config.AI_SERVICE_TIMEOUT_MS);
    // Read the body so the connection can be reused; its content is not needed.
    await response.arrayBuffer().catch(() => undefined);
    if (!response.ok) {
      throw new AiServiceError(`ai-service answered ${response.status}`, response.status);
    }
  }

  async function askAssistant(
    input: AskAssistantInput,
    requestId: string,
  ): Promise<AssistantAnswer> {
    await wake(requestId);
    const timeout = config.ASSISTANT_TIMEOUT_MS ?? config.AI_SERVICE_TIMEOUT_MS;
    const response = await send('/assistant/ask', input, requestId, timeout);
    let body: { data?: AssistantAnswer | null; error?: { code?: string } | null };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new AiServiceError(`ai-service answered ${response.status}`, response.status);
    }
    if (!response.ok || !body.data) {
      throw new AiServiceError(
        `ai-service answered ${response.status}`,
        response.status,
        body.error?.code ?? null,
      );
    }
    return body.data;
  }

  /** No wake: a sleeping ai-service has made no calls, and the dashboard must not wait. */
  async function aiBudget(projectId: string, requestId: string): Promise<AiBudget | null> {
    const query = new URLSearchParams({ projectId });
    let response: Response;
    try {
      response = await fetch(`${base}/internal/v1/llm/budget?${query.toString()}`, {
        headers: { 'X-Service-Token': config.AI_SERVICE_TOKEN, 'X-Request-ID': requestId },
        signal: AbortSignal.timeout(Math.min(config.AI_SERVICE_TIMEOUT_MS, BUDGET_TIMEOUT_MS)),
      });
    } catch (error) {
      throw new AiServiceError(`ai-service unreachable: ${String(error)}`);
    }
    const body = (await response.json().catch(() => null)) as { data?: unknown } | null;
    if (!response.ok || body === null) {
      throw new AiServiceError(`ai-service answered ${response.status}`, response.status);
    }
    if (body.data === null) return null;
    const parsed = aiBudgetSchema.safeParse(body.data);
    if (!parsed.success) throw new AiServiceError('ai-service sent an invalid budget');
    return parsed.data;
  }

  return {
    async enqueueJob(input, requestId) {
      await wake(requestId);
      await post('/jobs', input, requestId);
    },
    // No wake: a cancel is best effort, and the job is cancelled in MongoDB either way.
    cancelJob: (jobId, requestId) =>
      post(`/jobs/${encodeURIComponent(jobId)}/cancel`, {}, requestId),
    askAssistant,
    aiBudget,
  };
}
