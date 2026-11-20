import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';

function buildApp() {
  const config = loadConfig({ NODE_ENV: 'test' });
  return createApp({ config, logger: createLogger(config) });
}

describe('GET /api/v1/health', () => {
  it('returns ok in the standard envelope', async () => {
    const res = await request(buildApp()).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { status: 'ok', service: 'api' }, error: null });
  });

  it('echoes a valid incoming request id', async () => {
    const res = await request(buildApp()).get('/api/v1/health').set('X-Request-Id', 'abc-123');

    expect(res.headers['x-request-id']).toBe('abc-123');
  });
});

describe('unknown routes', () => {
  it('return NOT_FOUND in the error envelope', async () => {
    const res = await request(buildApp()).get('/api/v1/nope');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      data: null,
      error: { code: 'NOT_FOUND', message: 'Route not found.', details: null },
    });
  });
});
