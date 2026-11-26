import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { CONTENT_SECURITY_POLICY } from '../src/security-headers.js';

import { buildTestApp } from './support/build-app.js';
import { createMemoryRepositories } from './support/memory-repositories.js';

describe('security middleware', () => {
  it('sets a strict CSP and the other security headers', async () => {
    const res = await request(buildTestApp()).get('/api/v1/health');
    const csp = String(res.headers['content-security-policy']);

    expect(csp).toBe(
      "default-src 'self';script-src 'self';script-src-attr 'none';" +
        "style-src 'self' 'unsafe-inline';img-src 'self' data: blob:;font-src 'self';" +
        "connect-src 'self';frame-ancestors 'none';base-uri 'self';form-action 'self';" +
        "object-src 'none'",
    );
    expect(Object.keys(CONTENT_SECURITY_POLICY)).toHaveLength(csp.split(';').length);
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['permissions-policy']).toMatch(/camera=\(\), microphone=\(\)/);
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-powered-by']).toBeUndefined();
    // HSTS only in production (plain HTTP in development and tests).
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('sends HSTS in production', async () => {
    const app = buildTestApp({
      env: {
        NODE_ENV: 'production',
        MONGODB_URI: 'mongodb://mongo:27017/databridge',
        REDIS_URL: 'redis://redis:6379/0',
        JWT_ACCESS_SECRET: 'a'.repeat(40),
        JWT_REFRESH_SECRET: 'b'.repeat(40),
        AI_SERVICE_URL: 'http://ai-service:8000',
        AI_SERVICE_TOKEN: 'c'.repeat(40),
        CORS_ORIGIN: 'https://app.example.com',
      },
    });
    const res = await request(app).get('/api/v1/health');

    expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
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

  it('rate-limits sign-in per IP + email', async () => {
    const app = buildTestApp({ env: { AUTH_RATE_LIMIT_MAX: '3' } });
    const login = (email = 'a@example.com') =>
      request(app).post('/api/v1/auth/login').send({ email, password: 'x' });

    for (let i = 0; i < 3; i += 1) expect((await login()).status).toBe(401);
    const limited = await login();

    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.headers.ratelimit).toBeDefined();
    // The same email in another case is the same key; another account from this IP is not.
    expect((await login('A@Example.com')).status).toBe(429);
    expect((await login('b@example.com')).status).toBe(401);
    // Register shares the strict limiter; other routes are not limited by it.
    const register = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'a@example.com', name: 'A', password: 'long-enough-password' });
    expect(register.status).toBe(429);
    await request(app).get('/api/v1/health').expect(200);
  });

  it('keeps refresh, me and config usable after sign-in attempts are limited', async () => {
    const app = buildTestApp({ env: { AUTH_RATE_LIMIT_MAX: '1', SESSION_RATE_LIMIT_MAX: '3' } });
    const login = () =>
      request(app).post('/api/v1/auth/login').send({ email: 'a@example.com', password: 'x' });
    expect((await login()).status).toBe(401);
    expect((await login()).status).toBe(429);

    // Session routes have their own, more generous budget.
    expect((await request(app).post('/api/v1/auth/refresh')).status).toBe(401);
    expect((await request(app).get('/api/v1/auth/me')).status).toBe(401);
    expect((await request(app).get('/api/v1/auth/config')).status).toBe(200);
    const limited = await request(app).post('/api/v1/auth/refresh');
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });

  it('defaults to 10 sign-in attempts and 120 session calls per 15 minutes', async () => {
    const app = buildTestApp({
      env: { AUTH_RATE_LIMIT_MAX: undefined, SESSION_RATE_LIMIT_MAX: undefined },
    });
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'a@example.com', password: 'x' });
    const refresh = await request(app).post('/api/v1/auth/refresh');

    expect(login.headers['ratelimit-policy']).toMatch(/^"10-in-15min"; q=10; w=900/);
    expect(refresh.headers['ratelimit-policy']).toMatch(/^"120-in-15min"; q=120; w=900/);
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

  it('with TRUST_PROXY=1 uses the hop the proxy added, not a client-supplied one', async () => {
    // Render's proxy appends the real client address; anything to its left came from the client.
    const app = buildTestApp({ env: { AUTH_RATE_LIMIT_MAX: '1', TRUST_PROXY: '1' } });
    const login = (forwardedFor: string) =>
      request(app)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', forwardedFor)
        .send({ email: 'a@example.com', password: 'x' });

    expect((await login('198.51.100.7, 203.0.113.9')).status).toBe(401);
    // A new spoofed left-most value does not give the same client a fresh budget.
    expect((await login('198.51.100.8, 203.0.113.9')).status).toBe(429);
    expect((await login('203.0.113.10')).status).toBe(401);
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
