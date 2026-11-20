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
    expect(config.AUTH_RATE_LIMIT_MAX).toBe(20);
    expect(config.AUTH_RATE_LIMIT_WINDOW_MS).toBe(900_000);
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
});
