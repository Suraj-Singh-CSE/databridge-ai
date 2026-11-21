import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Express } from 'express';

import type { AiServiceClient } from '../../src/ai-service.client.js';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/logger.js';
import { createPasswordHasher } from '../../src/modules/auth/password.js';
import type { Repositories } from '../../src/repositories.js';
import { LocalDiskStorage } from '../../src/storage/local-disk.storage.js';
import type { FileStorage } from '../../src/storage/storage.types.js';
import type { JobEventBus } from '../../src/modules/jobs/job.events.js';

import { FakeAiService, MemoryJobEventBus } from './fakes.js';

import { createMemoryRepositories } from './memory-repositories.js';

/** bcrypt cost 4 keeps API tests fast; production cost 12 is asserted in password.test.ts. */
export const fastPasswords = createPasswordHasher(4);

/** A storage rooted in a fresh temporary directory (removed by the OS temp cleaner). */
export function tempStorage(): LocalDiskStorage {
  return new LocalDiskStorage(mkdtempSync(path.join(tmpdir(), 'databridge-uploads-')));
}

export interface TestAppOptions {
  repos?: Repositories;
  env?: NodeJS.ProcessEnv;
  storage?: FileStorage;
  jobEvents?: JobEventBus;
  aiService?: AiServiceClient;
}

export function buildTestApp(options: TestAppOptions = {}): Express {
  // High rate limit by default so suites are not throttled; rate-limit tests lower it.
  const config = loadConfig({ NODE_ENV: 'test', AUTH_RATE_LIMIT_MAX: '10000', ...options.env });
  return createApp({
    config,
    logger: createLogger(config),
    repos: options.repos ?? createMemoryRepositories(),
    passwords: fastPasswords,
    storage: options.storage ?? tempStorage(),
    jobEvents: options.jobEvents ?? new MemoryJobEventBus(),
    aiService: options.aiService ?? new FakeAiService(),
  });
}
