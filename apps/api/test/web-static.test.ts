import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { WebDistError } from '../src/web-static.js';

import { buildTestApp } from './support/build-app.js';

const INDEX_HTML =
  '<!doctype html><html><head><script type="module" src="/assets/index-abc123.js"></script>' +
  '</head><body><div id="root"></div></body></html>';

/** A fake Vite `dist`: index.html, one hashed asset and one unhashed public file. */
function fakeDist(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'databridge-web-'));
  mkdirSync(path.join(dir, 'assets'));
  writeFileSync(path.join(dir, 'index.html'), INDEX_HTML);
  writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), 'console.log("app");');
  writeFileSync(path.join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  return dir;
}

function webApp(env: NodeJS.ProcessEnv = {}) {
  return buildTestApp({ env: { SERVE_WEB: 'true', WEB_DIST_DIR: fakeDist(), ...env } });
}

describe('same-origin web app (SERVE_WEB=true)', () => {
  it('serves index.html at / and for client-side routes, never cached', async () => {
    const app = webApp();
    for (const url of ['/', '/projects', '/projects/abc/mapping?x=1', '/sign-in']) {
      const res = await request(app).get(url);
      expect(res.status, url).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/html/);
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.text).toBe(INDEX_HTML);
    }
    const head = await request(app).head('/projects');
    expect(head.status).toBe(200);
  });

  it('serves hashed assets as immutable for a year, and 404s a missing one', async () => {
    const app = webApp();
    const asset = await request(app).get('/assets/index-abc123.js');

    expect(asset.status).toBe(200);
    expect(asset.headers['content-type']).toMatch(/javascript/);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(asset.headers['x-content-type-options']).toBe('nosniff');

    const missing = await request(app).get('/assets/index-old999.js');
    expect(missing.status).toBe(404);
    expect(missing.headers['content-type']).toMatch(/^text\/plain/);
    expect(missing.text).not.toContain('<html');
  });

  it('serves other dist files with no-cache and blocks path traversal', async () => {
    const app = webApp();
    const favicon = await request(app).get('/favicon.svg');

    expect(favicon.status).toBe(200);
    expect(favicon.headers['cache-control']).toBe('no-cache');

    const traversal = await request(app).get('/assets/..%2f..%2fpackage.json');
    expect(traversal.status).toBe(404);
    expect(traversal.text).not.toContain('"name"');
  });

  it('keeps /api JSON: health works, unknown /api routes are JSON 404s', async () => {
    const app = webApp();
    await request(app).get('/api/v1/health').expect(200);

    for (const url of ['/api', '/api/v1/nope', '/api/v2/projects', '/api/index.html']) {
      const res = await request(app).get(url);
      expect(res.status, url).toBe(404);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(res.body).toEqual({
        data: null,
        error: { code: 'NOT_FOUND', message: 'Route not found.', details: null },
      });
    }
  });

  it('answers non-GET requests outside /api with a JSON 404, not the page', async () => {
    const res = await request(webApp()).post('/projects').send({});

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('sends the CSP and security headers with the page', async () => {
    const res = await request(webApp()).get('/projects');

    expect(res.headers['content-security-policy']).toContain("script-src 'self';");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['permissions-policy']).toBeDefined();
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
  });

  it('refuses to start when the build is missing', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'databridge-web-empty-'));

    expect(() => buildTestApp({ env: { SERVE_WEB: 'true', WEB_DIST_DIR: empty } })).toThrow(
      WebDistError,
    );
  });

  it('serves no page when SERVE_WEB is off (the default)', async () => {
    const res = await request(buildTestApp({ env: { WEB_DIST_DIR: fakeDist() } })).get('/');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('sets the Secure refresh cookie in production, also in single-origin mode', async () => {
    const app = webApp({
      NODE_ENV: 'production',
      MONGODB_URI: 'mongodb://mongo:27017/databridge',
      REDIS_URL: 'redis://redis:6379/0',
      JWT_ACCESS_SECRET: 'a'.repeat(40),
      JWT_REFRESH_SECRET: 'b'.repeat(40),
      AI_SERVICE_URL: 'http://ai-service:8000',
      AI_SERVICE_TOKEN: 'c'.repeat(40),
      CORS_ORIGIN: 'https://databridge.example.com',
    });
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'a@example.com', name: 'A', password: 'long-enough-password' });
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0] ?? '';

    expect(res.status).toBe(201);
    expect(cookie).toMatch(/; Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/HttpOnly/);
  });
});
