import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AI_SERVICE_WAKING,
  AiServiceError,
  createAiServiceClient,
} from '../src/ai-service.client.js';

interface Received {
  method: string | undefined;
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let server: http.Server | null = null;

async function fakeAiService(
  status: number,
  delayMs = 0,
  answer = '{"data":null,"error":null}',
): Promise<{ url: string; seen: Received[] }> {
  const seen: Received[] = [];
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      setTimeout(() => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(answer);
      }, delayMs);
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, seen };
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
  server = null;
});

const config = (url: string, timeout = 1000) => ({
  AI_SERVICE_URL: url,
  AI_SERVICE_TOKEN: 'service-token-for-tests',
  AI_SERVICE_TIMEOUT_MS: timeout,
});

describe('ai-service client', () => {
  it('posts the job with the service token and request id', async () => {
    const { url, seen } = await fakeAiService(202);
    const client = createAiServiceClient(config(url));

    await client.enqueueJob(
      { jobId: 'j1', projectId: 'p1', type: 'demo', payload: { steps: 1 } },
      'req-1',
    );
    await client.cancelJob('j1', 'req-2');

    expect(seen.map((r) => [r.method, r.url])).toEqual([
      ['POST', '/internal/v1/jobs'],
      ['POST', '/internal/v1/jobs/j1/cancel'],
    ]);
    expect(seen[0]?.headers['x-service-token']).toBe('service-token-for-tests');
    expect(seen[0]?.headers['x-request-id']).toBe('req-1');
    expect(seen[1]?.headers['x-request-id']).toBe('req-2');
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual({
      jobId: 'j1',
      projectId: 'p1',
      type: 'demo',
      payload: { steps: 1 },
    });
  });

  it('throws AiServiceError with the status on an error answer', async () => {
    const { url } = await fakeAiService(503);
    const client = createAiServiceClient(config(url));

    const error = await client.cancelJob('j1', 'r').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiServiceError);
    expect((error as AiServiceError).status).toBe(503);
  });

  it('throws AiServiceError when unreachable or too slow', async () => {
    const unreachable = createAiServiceClient(config('http://127.0.0.1:1'));
    await expect(unreachable.cancelJob('j1', 'r')).rejects.toBeInstanceOf(AiServiceError);

    const { url } = await fakeAiService(202, 500);
    const slow = createAiServiceClient(config(url, 100));
    await expect(slow.cancelJob('j1', 'r')).rejects.toThrow(/unreachable/);
  });

  it('asks the assistant and returns its answer, or the error code', async () => {
    const data = { answer: 'Because [1].', citations: [], answerable: true };
    const ok = await fakeAiService(200, 0, JSON.stringify({ data, error: null }));
    const client = createAiServiceClient({ ...config(ok.url), ASSISTANT_TIMEOUT_MS: 1000 });
    const input = { projectId: 'p1', question: 'Why?', history: [] };
    await expect(client.askAssistant(input, 'req-3')).resolves.toEqual(data);
    expect(ok.seen[0]?.url).toBe('/internal/v1/assistant/ask');
    expect(JSON.parse(ok.seen[0]?.body ?? '')).toEqual(input);
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));

    const refused = await fakeAiService(
      409,
      0,
      JSON.stringify({ data: null, error: { code: 'KNOWLEDGE_NOT_BUILT', message: 'x' } }),
    );
    const error = await createAiServiceClient(config(refused.url))
      .askAssistant(input, 'r')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiServiceError);
    expect(error).toMatchObject({ status: 409, code: 'KNOWLEDGE_NOT_BUILT' });
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));

    const broken = await fakeAiService(502, 0, 'not json');
    await expect(
      createAiServiceClient(config(broken.url)).askAssistant(input, 'r'),
    ).rejects.toMatchObject({ status: 502, code: null });
  });

  describe('waking a sleeping ai-service (free hosting)', () => {
    /** /health answers 503 for the first `sleepyFor` requests, then 200; the rest answer 202. */
    async function sleepyService(sleepyFor: number) {
      const seen: string[] = [];
      let health = 0;
      server = http.createServer((req, res) => {
        seen.push(`${req.method} ${req.url}`);
        req.resume();
        req.on('end', () => {
          if (req.url === '/internal/v1/health') {
            health += 1;
            res.writeHead(health > sleepyFor ? 200 : 503).end('{}');
            return;
          }
          res.writeHead(202).end('{}');
        });
      });
      await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      return { url: `http://127.0.0.1:${port}`, seen };
    }

    /** A virtual clock that only moves when the client sleeps. */
    function virtualTime() {
      const clock = { now: 1_000_000, sleeps: [] as number[] };
      return {
        clock,
        timing: {
          now: () => clock.now,
          sleep: async (ms: number) => {
            clock.sleeps.push(ms);
            clock.now += ms;
            await Promise.resolve();
          },
        },
      };
    }

    const job = { jobId: 'j1', projectId: 'p1', type: 'demo', payload: {} };

    it('polls /health with backoff until it answers, then enqueues', async () => {
      const { url, seen } = await sleepyService(3);
      const { clock, timing } = virtualTime();
      const client = createAiServiceClient(
        { ...config(url), AI_SERVICE_WAKE_TIMEOUT_MS: 90_000 },
        timing,
      );

      await client.enqueueJob(job, 'r1');

      expect(seen).toEqual([
        'GET /internal/v1/health',
        'GET /internal/v1/health',
        'GET /internal/v1/health',
        'GET /internal/v1/health',
        'POST /internal/v1/jobs',
      ]);
      expect(clock.sleeps).toEqual([1000, 2000, 4000]);

      // Awake now: the next call within a minute goes straight to the route.
      await client.enqueueJob(job, 'r2');
      expect(seen.slice(5)).toEqual(['POST /internal/v1/jobs']);
      // A minute later it checks again (the service may have gone back to sleep).
      clock.now += 61_000;
      await client.enqueueJob(job, 'r3');
      expect(seen.slice(6)).toEqual(['GET /internal/v1/health', 'POST /internal/v1/jobs']);
    });

    it('gives up with AI_SERVICE_WAKING after the wake timeout, without enqueueing', async () => {
      const { url, seen } = await sleepyService(Number.POSITIVE_INFINITY);
      const { clock, timing } = virtualTime();
      const client = createAiServiceClient(
        { ...config(url), AI_SERVICE_WAKE_TIMEOUT_MS: 20_000 },
        timing,
      );

      const error = await client.enqueueJob(job, 'r').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AiServiceError);
      expect(error).toMatchObject({ status: 503, code: AI_SERVICE_WAKING });
      expect(seen.every((line) => line === 'GET /internal/v1/health')).toBe(true);
      expect(clock.sleeps).toEqual([1000, 2000, 4000, 8000, 5000]); // capped at 8 s, then the rest
      await expect(
        client.askAssistant({ projectId: 'p', question: 'q', history: [] }, 'r'),
      ).rejects.toMatchObject({ code: AI_SERVICE_WAKING });
    });

    it('does not wake when the wake timeout is 0, nor before a cancel', async () => {
      const { url, seen } = await sleepyService(0);
      const client = createAiServiceClient({ ...config(url), AI_SERVICE_WAKE_TIMEOUT_MS: 0 });
      await client.enqueueJob(job, 'r');
      const waking = createAiServiceClient({ ...config(url), AI_SERVICE_WAKE_TIMEOUT_MS: 5000 });
      await waking.cancelJob('j1', 'r');
      expect(seen).toEqual(['POST /internal/v1/jobs', 'POST /internal/v1/jobs/j1/cancel']);
    });
  });
});
