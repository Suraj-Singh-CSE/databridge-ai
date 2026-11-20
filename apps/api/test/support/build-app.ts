import type { Express } from 'express';

import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/logger.js';
import { createPasswordHasher } from '../../src/modules/auth/password.js';
import type { Repositories } from '../../src/repositories.js';

import { createMemoryRepositories } from './memory-repositories.js';

/** bcrypt cost 4 keeps API tests fast; production cost 12 is asserted in password.test.ts. */
export const fastPasswords = createPasswordHasher(4);

export function buildTestApp(
  options: { repos?: Repositories; env?: NodeJS.ProcessEnv } = {},
): Express {
  // High rate limit by default so suites are not throttled; rate-limit tests lower it.
  const config = loadConfig({ NODE_ENV: 'test', AUTH_RATE_LIMIT_MAX: '10000', ...options.env });
  return createApp({
    config,
    logger: createLogger(config),
    repos: options.repos ?? createMemoryRepositories(),
    passwords: fastPasswords,
  });
}
