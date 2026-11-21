import type { Config } from './config.js';

export interface EnqueueJobInput {
  jobId: string;
  projectId: string;
  type: string;
  payload: Record<string, unknown>;
}

/** The internal ai-service routes the api calls (`/internal/v1`, `X-Service-Token`). */
export interface AiServiceClient {
  enqueueJob(input: EnqueueJobInput, requestId: string): Promise<void>;
  cancelJob(jobId: string, requestId: string): Promise<void>;
}

/** The ai-service could not be reached, timed out, or answered with an error status. */
export class AiServiceError extends Error {
  override readonly name = 'AiServiceError';

  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

type ClientConfig = Pick<Config, 'AI_SERVICE_URL' | 'AI_SERVICE_TOKEN' | 'AI_SERVICE_TIMEOUT_MS'>;

export function createAiServiceClient(config: ClientConfig): AiServiceClient {
  const base = config.AI_SERVICE_URL.replace(/\/+$/, '');

  async function post(path: string, body: unknown, requestId: string): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${base}/internal/v1${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Token': config.AI_SERVICE_TOKEN,
          'X-Request-ID': requestId,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.AI_SERVICE_TIMEOUT_MS),
      });
    } catch (error) {
      throw new AiServiceError(`ai-service unreachable: ${String(error)}`);
    }
    // Read the body so the connection can be reused; its content is not needed.
    await response.arrayBuffer().catch(() => undefined);
    if (!response.ok) {
      throw new AiServiceError(`ai-service answered ${response.status}`, response.status);
    }
  }

  return {
    enqueueJob: (input, requestId) => post('/jobs', input, requestId),
    cancelJob: (jobId, requestId) =>
      post(`/jobs/${encodeURIComponent(jobId)}/cancel`, {}, requestId),
  };
}
