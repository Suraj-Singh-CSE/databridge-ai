import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('fills safe defaults in test mode', () => {
    const config = loadConfig({ NODE_ENV: 'test' });

    expect(config.PORT).toBe(4000);
    expect(config.AI_SERVICE_URL).toBe('http://localhost:8000');
  });

  it('fails fast outside test mode, naming missing variables without values', () => {
    const run = () => loadConfig({ NODE_ENV: 'production', JWT_ACCESS_SECRET: 'short' });

    expect(run).toThrow(ConfigError);
    expect(run).toThrow(/MONGODB_URI: is required/);
    expect(run).toThrow(/JWT_ACCESS_SECRET: must be at least 32 characters/);
    expect(run).not.toThrow(/short/);
  });
});
