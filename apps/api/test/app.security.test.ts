import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { buildTestApp } from './support/build-app.js';
import { createMemoryRepositories } from './support/memory-repositories.js';

describe('security middleware', () => {
  it('sets helmet security headers', async () => {
    const res = await request(buildTestApp()).get('/api/v1/health');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('allows credentialed CORS only for CORS_ORIGIN', async () => {
    const app = buildTestApp({ env: { CORS_ORIGIN: 'https://app.example.com' } });
    const preflight = await request(app)
      .options('/api/v1/auth/login')
      .set('Origin', 'https://app.example.com')
      .set('Access-Control-Request-Method', 'POST');

    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('https://app.example.com');
    expect(preflight.headers['access-control-allow-credentials']).toBe('true');

    const other = await request(app).get('/api/v1/health').set('Origin', 'https://evil.example');
    expect(other.headers['access-control-allow-origin']).not.toBe('https://evil.example');
  });

  it('rate-limits /api/v1/auth/* per IP', async () => {
    const app = buildTestApp({ env: { AUTH_RATE_LIMIT_MAX: '3' } });
    const login = () =>
      request(app).post('/api/v1/auth/login').send({ email: 'a@example.com', password: 'x' });

    for (let i = 0; i < 3; i += 1) expect((await login()).status).toBe(401);
    const limited = await login();

    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.headers.ratelimit).toBeDefined();
    // Other routes are not limited.
    await request(app).get('/api/v1/health').expect(200);
  });

  it('uses X-Forwarded-For for the client IP only when TRUST_PROXY is set', async () => {
    const trusted = buildTestApp({ env: { AUTH_RATE_LIMIT_MAX: '1', TRUST_PROXY: '1' } });
    const login = (ip: string) =>
      request(trusted)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email: 'a@example.com', password: 'x' });

    expect((await login('203.0.113.1')).status).toBe(401);
    expect((await login('203.0.113.1')).status).toBe(429);
    expect((await login('203.0.113.2')).status).toBe(401);

    const untrusted = buildTestApp({ env: { AUTH_RATE_LIMIT_MAX: '1' } });
    const spoof = (ip: string) =>
      request(untrusted)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email: 'a@example.com', password: 'x' });
    expect((await spoof('203.0.113.1')).status).toBe(401);
    expect((await spoof('203.0.113.2')).status).toBe(429);
  });

  it('rejects malformed JSON with 400', async () => {
    const res = await request(buildTestApp())
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email":');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects bodies over 1 MB with 413', async () => {
    const res = await request(buildTestApp())
      .post('/api/v1/auth/login')
      .send({ email: 'a@example.com', password: 'x'.repeat(1024 * 1024) });

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('hides unexpected errors behind INTERNAL_ERROR', async () => {
    const repos = createMemoryRepositories();
    repos.users.findCredentialsByEmail = () => Promise.reject(new Error('db exploded: secret'));
    const res = await request(buildTestApp({ repos }))
      .post('/api/v1/auth/login')
      .send({ email: 'a@example.com', password: 'whatever' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      data: null,
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.', details: null },
    });
  });
});
