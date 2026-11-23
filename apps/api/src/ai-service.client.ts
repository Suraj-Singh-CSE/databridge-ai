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
  'personal_data' | 'weak_retrieval' | 'not_answerable' | 'no_citation';

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

/** The internal ai-service routes the api calls (`/internal/v1`, `X-Service-Token`). */
export interface AiServiceClient {
  enqueueJob(input: EnqueueJobInput, requestId: string): Promise<void>;
  cancelJob(jobId: string, requestId: string): Promise<void>;
  askAssistant(input: AskAssistantInput, requestId: string): Promise<AssistantAnswer>;
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
  Partial<Pick<Config, 'ASSISTANT_TIMEOUT_MS'>>;

export function createAiServiceClient(config: ClientConfig): AiServiceClient {
  const base = config.AI_SERVICE_URL.replace(/\/+$/, '');

  async function send(
    path: string,
    body: unknown,
    requestId: string,
    timeoutMs: number,
  ): Promise<Response> {
    try {
      return await fetch(`${base}/internal/v1${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Token': config.AI_SERVICE_TOKEN,
          'X-Request-ID': requestId,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
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

  return {
    enqueueJob: (input, requestId) => post('/jobs', input, requestId),
    cancelJob: (jobId, requestId) =>
      post(`/jobs/${encodeURIComponent(jobId)}/cancel`, {}, requestId),
    askAssistant,
  };
}
