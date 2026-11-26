import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import {
  createRetentionService,
  scheduleRetentionSweep,
  type RetentionService,
} from '../src/modules/retention/retention.service.js';

import { tempStorage } from './support/build-app.js';
import { createMemoryRepositories } from './support/memory-repositories.js';

const config = loadConfig({ NODE_ENV: 'test' });
const logger = createLogger(config);

describe('retention sweep', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs every step even when one fails, and counts nothing for the failed one', async () => {
    const repos = createMemoryRepositories();
    repos.retention.trimAudit = () => Promise.reject(new Error('audit down'));
    const service = createRetentionService(repos, tempStorage(), config, logger);

    await expect(service.sweep()).resolves.toEqual({
      exports: 0,
      qualityRuns: 0,
      auditEntries: 0,
      orphanRunRows: 0,
    });
  });

  it('reports no total when the server hides byte sizes', async () => {
    const service = createRetentionService(
      createMemoryRepositories(),
      tempStorage(),
      config,
      logger,
    );
    const report = await service.report();
    expect(report.totalStorageBytes).toBeNull();
    expect(report.collections.length).toBeGreaterThan(0);
  });

  it('sweeps once at startup and then on the interval; 0 turns it off', async () => {
    vi.useFakeTimers();
    const sweep = vi.fn(() =>
      Promise.resolve({ exports: 0, qualityRuns: 0, auditEntries: 0, orphanRunRows: 0 }),
    );
    const service: RetentionService = { sweep, report: vi.fn() };

    const off = scheduleRetentionSweep(service, 0, logger);
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
    expect(sweep).not.toHaveBeenCalled();
    off();

    const stop = scheduleRetentionSweep(service, 60, logger);
    await vi.advanceTimersByTimeAsync(0);
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(sweep).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it('logs a failed sweep instead of crashing', async () => {
    vi.useFakeTimers();
    const service: RetentionService = {
      sweep: () => Promise.reject(new Error('mongo down')),
      report: vi.fn(),
    };
    const stop = scheduleRetentionSweep(service, 60, logger);
    await expect(vi.advanceTimersByTimeAsync(0)).resolves.toBeDefined();
    stop();
  });
});
