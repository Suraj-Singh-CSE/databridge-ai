import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { AiServiceError, createAiServiceClient } from '../src/ai-service.client.js';

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
): Promise<{ url: string; seen: Received[] }> {
  const seen: Received[] = [];
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      setTimeout(() => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end('{"data":null,"error":null}');
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
});
