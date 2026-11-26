import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/config.js';

const PRODUCTION_ENV = {
  NODE_ENV: 'production',
  MONGODB_URI: 'mongodb://mongo:27017/databridge',
  REDIS_URL: 'redis://redis:6379/0',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  AI_SERVICE_URL: 'http://ai-service:8000',
  AI_SERVICE_TOKEN: 'c'.repeat(40),
  CORS_ORIGIN: 'https://app.example.com',
} as const;

describe('loadConfig', () => {
  it('fills safe defaults in test mode', () => {
    const config = loadConfig({ NODE_ENV: 'test' });

    expect(config.PORT).toBe(4000);
    expect(config.AI_SERVICE_URL).toBe('http://localhost:8000');
    expect(config.TRUST_PROXY).toBe(false);
    expect(config.AUTH_RATE_LIMIT_MAX).toBe(10);
    expect(config.AUTH_RATE_LIMIT_WINDOW_MS).toBe(900_000);
    expect(config.SESSION_RATE_LIMIT_MAX).toBe(120);
    expect(config.SESSION_RATE_LIMIT_WINDOW_MS).toBe(900_000);
    expect(config.REGISTRATION_MODE).toBe('open');
    expect(config.REGISTRATION_INVITE_CODES).toEqual([]);
    expect(config.BOOTSTRAP_ADMIN_EMAIL).toBeUndefined();
    expect(config.SERVE_WEB).toBe(false);
    expect(config.WEB_DIST_DIR).toBe('../web/dist');
  });

  it('parses TRUST_PROXY as false, true, a hop count or a pass-through value', () => {
    const trust = (value: string) =>
      loadConfig({ NODE_ENV: 'test', TRUST_PROXY: value }).TRUST_PROXY;

    expect(trust('false')).toBe(false);
    expect(trust('true')).toBe(true);
    expect(trust('1')).toBe(1);
    expect(trust('loopback')).toBe('loopback');
  });

  it('normalises BOOTSTRAP_ADMIN_EMAIL and treats an empty value as unset', () => {
    const load = (value: string) =>
      loadConfig({ NODE_ENV: 'test', BOOTSTRAP_ADMIN_EMAIL: value }).BOOTSTRAP_ADMIN_EMAIL;

    expect(load('  Boss@Example.COM ')).toBe('boss@example.com');
    expect(load('')).toBeUndefined();
    expect(() => load('not-an-email')).toThrow(/BOOTSTRAP_ADMIN_EMAIL/);
  });

  it('requires invite codes of 8+ characters in invite mode', () => {
    const load = (codes?: string) =>
      loadConfig({
        NODE_ENV: 'test',
        REGISTRATION_MODE: 'invite',
        ...(codes === undefined ? {} : { REGISTRATION_INVITE_CODES: codes }),
      });

    expect(() => load()).toThrow(/REGISTRATION_INVITE_CODES: is required/);
    expect(() => load('short')).toThrow(/at least 8 characters/);
    expect(load(' first-code-1 , second-code-2 ,').REGISTRATION_INVITE_CODES).toEqual([
      'first-code-1',
      'second-code-2',
    ]);
    expect(() => loadConfig({ NODE_ENV: 'test', REGISTRATION_MODE: 'maybe' })).toThrow(
      /REGISTRATION_MODE/,
    );
  });

  it('refuses placeholder invite codes in production, without printing them', () => {
    const run = () =>
      loadConfig({
        ...PRODUCTION_ENV,
        REGISTRATION_MODE: 'invite',
        REGISTRATION_INVITE_CODES: 'CHANGE-ME-invite',
      });

    expect(run).toThrow(/REGISTRATION_INVITE_CODES: still contains/);
    expect(run).not.toThrow(/CHANGE-ME-invite/);
  });

  it('parses SERVE_WEB as a boolean flag', () => {
    expect(loadConfig({ NODE_ENV: 'test', SERVE_WEB: 'true' }).SERVE_WEB).toBe(true);
    expect(() => loadConfig({ NODE_ENV: 'test', SERVE_WEB: 'yes' })).toThrow(/SERVE_WEB/);
  });

  it('fails fast outside test mode, naming missing variables without values', () => {
    const run = () => loadConfig({ NODE_ENV: 'production', JWT_ACCESS_SECRET: 'short' });

    expect(run).toThrow(ConfigError);
    expect(run).toThrow(/MONGODB_URI: is required/);
    expect(run).toThrow(/JWT_ACCESS_SECRET: must be at least 32 characters/);
    expect(run).not.toThrow(/short/);
  });

  it('accepts a complete production configuration', () => {
    expect(loadConfig(PRODUCTION_ENV).NODE_ENV).toBe('production');
  });

  it.each(['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'AI_SERVICE_TOKEN'] as const)(
    'refuses a %s that still contains "change-me" in production',
    (key) => {
      const placeholder = `Change-Me-${'x'.repeat(40)}`;
      const run = () => loadConfig({ ...PRODUCTION_ENV, [key]: placeholder });

      expect(run).toThrow(ConfigError);
      expect(run).toThrow(new RegExp(`${key}: still contains the "change-me" placeholder`));
      expect(run).not.toThrow(placeholder);
    },
  );

  it('refuses identical access and refresh secrets in production', () => {
    const run = () =>
      loadConfig({ ...PRODUCTION_ENV, JWT_REFRESH_SECRET: PRODUCTION_ENV.JWT_ACCESS_SECRET });

    expect(run).toThrow(/JWT_REFRESH_SECRET: must be different from JWT_ACCESS_SECRET/);
  });

  it('allows the .env.example placeholders outside production', () => {
    const config = loadConfig({
      ...PRODUCTION_ENV,
      NODE_ENV: 'development',
      JWT_ACCESS_SECRET: 'change-me-access-secret-min-32-characters',
      JWT_REFRESH_SECRET: 'change-me-access-secret-min-32-characters',
    });

    expect(config.NODE_ENV).toBe('development');
  });

  it.each([
    ['false', false],
    ['true', true],
    ['2', 2],
    ['loopback', 'loopback'],
    ['', false],
  ] as const)('parses TRUST_PROXY=%j', (value, expected) => {
    expect(loadConfig({ NODE_ENV: 'test', TRUST_PROXY: value }).TRUST_PROXY).toBe(expected);
  });

  it('defaults and validates the background job settings', () => {
    const config = loadConfig({ NODE_ENV: 'test' });

    expect(config.JOB_STALE_AFTER_SECONDS).toBe(300);
    expect(config.JOB_EVENTS_KEEPALIVE_MS).toBe(15_000);
    expect(config.AI_SERVICE_TIMEOUT_MS).toBe(5000);
    expect(config.AI_SERVICE_WAKE_TIMEOUT_MS).toBe(90_000);
    expect(config.JOB_QUEUED_STALE_AFTER_SECONDS).toBe(600);
    expect(
      loadConfig({ NODE_ENV: 'test', AI_SERVICE_WAKE_TIMEOUT_MS: '0' }).AI_SERVICE_WAKE_TIMEOUT_MS,
    ).toBe(0);
    expect(() => loadConfig({ NODE_ENV: 'test', AI_SERVICE_WAKE_TIMEOUT_MS: '-1' })).toThrow(
      /AI_SERVICE_WAKE_TIMEOUT_MS/,
    );
    expect(() => loadConfig({ NODE_ENV: 'test', JOB_QUEUED_STALE_AFTER_SECONDS: '0' })).toThrow(
      /JOB_QUEUED_STALE_AFTER_SECONDS/,
    );
    expect(() => loadConfig({ NODE_ENV: 'test', JOB_STALE_AFTER_SECONDS: '0' })).toThrow(
      /JOB_STALE_AFTER_SECONDS/,
    );
    expect(() => loadConfig({ NODE_ENV: 'test', JOB_EVENTS_KEEPALIVE_MS: '5' })).toThrow(
      /JOB_EVENTS_KEEPALIVE_MS/,
    );
  });

  it('defaults and validates the quality threshold settings', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    expect(config.QUALITY_FRESHNESS_WARN_HOURS).toBe(24);
    expect(config.QUALITY_FRESHNESS_FAIL_HOURS).toBe(168);
    expect(config.QUALITY_ROW_CHANGE_WARN_PERCENT).toBe(20);
    expect(() =>
      loadConfig({
        NODE_ENV: 'test',
        QUALITY_FRESHNESS_WARN_HOURS: '48',
        QUALITY_FRESHNESS_FAIL_HOURS: '24',
      }),
    ).toThrow(/QUALITY_FRESHNESS_FAIL_HOURS/);
    expect(() => loadConfig({ NODE_ENV: 'test', QUALITY_FRESHNESS_WARN_HOURS: '0' })).toThrow(
      /QUALITY_FRESHNESS_WARN_HOURS/,
    );
  });

  it('defaults the upload and storage settings', () => {
    const config = loadConfig({ NODE_ENV: 'test' });

    expect(config).toMatchObject({
      STORAGE_DRIVER: 'local',
      UPLOAD_DIR: './data/uploads',
      MAX_UPLOAD_BYTES: 50 * 1024 * 1024,
      MAX_UPLOAD_ROWS: 200_000,
      MAX_SOURCES_PER_PROJECT: 10,
      UPLOAD_RATE_LIMIT_MAX: 30,
      UPLOAD_RATE_LIMIT_WINDOW_MS: 3_600_000,
      S3_FORCE_PATH_STYLE: false,
      XLSX_MAX_UNCOMPRESSED_BYTES: 200 * 1024 * 1024,
      XLSX_MAX_COMPRESSION_RATIO: 100,
    });
    expect(config.S3_BUCKET).toBeUndefined();
  });

  it('treats empty optional S3 variables (as compose passes them) as unset', () => {
    const config = loadConfig({ NODE_ENV: 'test', S3_BUCKET: '', S3_ENDPOINT: '' });

    expect(config.S3_BUCKET).toBeUndefined();
    expect(config.S3_ENDPOINT).toBeUndefined();
  });

  it('requires a bucket and region for STORAGE_DRIVER=s3, and both keys or neither', () => {
    const run = () =>
      loadConfig({ NODE_ENV: 'test', STORAGE_DRIVER: 's3', S3_ACCESS_KEY_ID: 'only-the-id' });

    expect(run).toThrow(/S3_BUCKET: is required when STORAGE_DRIVER=s3/);
    expect(run).toThrow(/S3_REGION: is required when STORAGE_DRIVER=s3/);
    expect(run).toThrow(/S3_SECRET_ACCESS_KEY: set both/);
    expect(run).not.toThrow(/only-the-id/);
  });

  it('rejects invalid upload limits and storage settings', () => {
    const run = () =>
      loadConfig({
        NODE_ENV: 'test',
        STORAGE_DRIVER: 'ftp',
        MAX_UPLOAD_BYTES: '0',
        MAX_UPLOAD_ROWS: 'many',
        S3_ENDPOINT: 'not a url',
        XLSX_MAX_UNCOMPRESSED_BYTES: '1000',
        XLSX_MAX_COMPRESSION_RATIO: '2',
      });

    expect(run).toThrow(/STORAGE_DRIVER/);
    expect(run).toThrow(/MAX_UPLOAD_BYTES/);
    expect(run).toThrow(/MAX_UPLOAD_ROWS/);
    expect(run).toThrow(/S3_ENDPOINT: must be a valid URL/);
    expect(run).toThrow(/XLSX_MAX_UNCOMPRESSED_BYTES/);
    expect(run).toThrow(/XLSX_MAX_COMPRESSION_RATIO/);
  });

  it('accepts the free demo profile once its secrets are filled in', () => {
    const file = readFileSync(new URL('../../../.env.free-tier.example', import.meta.url), 'utf8');
    const env: Record<string, string> = {};
    for (const line of file.split('\n')) {
      if (!line.trim() || line.startsWith('#')) continue;
      const at = line.indexOf('=');
      env[line.slice(0, at)] = line.slice(at + 1);
    }
    env.JWT_ACCESS_SECRET = 'a'.repeat(48);
    env.JWT_REFRESH_SECRET = 'b'.repeat(48);
    env.AI_SERVICE_TOKEN = 'c'.repeat(48);
    env.REGISTRATION_INVITE_CODES = 'demo-invite-code-1';

    const config = loadConfig(env);

    expect(config.STORAGE_DRIVER).toBe('s3');
    expect(config.S3_REGION).toBe('auto');
    expect(config.MAX_UPLOAD_ROWS).toBe(20_000);
    expect(config.MAX_SOURCES_PER_PROJECT).toBe(4);
    expect(config.MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
    expect(config.AI_SERVICE_WAKE_TIMEOUT_MS).toBe(90_000);
    expect(config.TRUST_PROXY).toBe(1);
    expect(config.SERVE_WEB).toBe(true);
    expect(config.REGISTRATION_MODE).toBe('invite');
    expect(config.BOOTSTRAP_ADMIN_EMAIL).toBe('you@example.com');
    // The placeholders themselves are refused in production.
    expect(() => loadConfig({ ...env, AI_SERVICE_TOKEN: 'CHANGE-ME-service-token' })).toThrow(
      /AI_SERVICE_TOKEN/,
    );
  });
});
