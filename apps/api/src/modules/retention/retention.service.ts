import type { Config } from '../../config.js';
import type { Logger } from '../../logger.js';
import type { Repositories } from '../../repositories.js';
import { exportFileKey } from '../../storage/keys.js';
import type { FileStorage } from '../../storage/storage.types.js';

import type { CollectionUsage } from './retention.types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Atlas M0's storage limit. */
export const FREE_TIER_LIMIT_BYTES = 512 * 1024 * 1024;
/** Exports removed per sweep, so one sweep stays short; the rest go in the next one. */
const EXPORTS_PER_SWEEP = 200;

export type RetentionSettings = Pick<
  Config,
  | 'JOB_RETENTION_DAYS'
  | 'LLM_CALL_RETENTION_DAYS'
  | 'ASSISTANT_RETENTION_DAYS'
  | 'EXPORT_RETENTION_DAYS'
  | 'QUALITY_RUN_RETENTION_DAYS'
  | 'AUDIT_MAX_ENTRIES_PER_PROJECT'
>;

export interface SweepResult {
  exports: number;
  qualityRuns: number;
  auditEntries: number;
  orphanRunRows: number;
}

export interface StorageReport {
  collections: CollectionUsage[];
  /** Sum of the known storage sizes; null when the server reports none. */
  totalStorageBytes: number | null;
  limitBytes: number;
  retention: {
    jobsDays: number;
    llmCallsDays: number;
    assistantDays: number;
    exportsDays: number;
    qualityRunsDays: number;
    auditMaxEntriesPerProject: number;
  };
}

export interface RetentionService {
  /** One housekeeping pass (G3-11); each step runs even when an earlier one failed. */
  sweep(): Promise<SweepResult>;
  report(): Promise<StorageReport>;
}

export function createRetentionService(
  repos: Pick<Repositories, 'retention' | 'exports'>,
  storage: FileStorage,
  settings: RetentionSettings,
  logger: Logger,
  now: () => Date = () => new Date(),
): RetentionService {
  const daysAgo = (days: number) => new Date(now().getTime() - days * DAY_MS);

  /** Deletes each expired export's file first, then its metadata (a crash leaves no orphan). */
  async function expireExports(): Promise<number> {
    const expired = await repos.retention.listExportsBefore(
      daysAgo(settings.EXPORT_RETENTION_DAYS),
      EXPORTS_PER_SWEEP,
    );
    let removed = 0;
    for (const record of expired) {
      await storage.delete(exportFileKey(record.projectId, record.id, record.format));
      if (await repos.exports.delete(record.projectId, record.id)) removed += 1;
    }
    return removed;
  }

  async function step(name: keyof SweepResult, run: () => Promise<number>): Promise<number> {
    try {
      return await run();
    } catch (error) {
      logger.error({ err: error, step: name }, 'retention sweep step failed');
      return 0;
    }
  }

  return {
    async sweep() {
      const result: SweepResult = {
        exports: await step('exports', expireExports),
        qualityRuns: await step('qualityRuns', () =>
          repos.retention.pruneQualityRuns(daysAgo(settings.QUALITY_RUN_RETENTION_DAYS)),
        ),
        auditEntries: await step('auditEntries', () =>
          repos.retention.trimAudit(settings.AUDIT_MAX_ENTRIES_PER_PROJECT),
        ),
        orphanRunRows: await step('orphanRunRows', () => repos.retention.deleteOrphanRuns()),
      };
      logger.info({ retention: result }, 'retention sweep finished');
      return result;
    },

    async report() {
      const collections = await repos.retention.collectionUsage();
      const known = collections.filter((c) => c.storageBytes !== null);
      return {
        collections,
        totalStorageBytes:
          known.length > 0 ? known.reduce((sum, c) => sum + (c.storageBytes ?? 0), 0) : null,
        limitBytes: FREE_TIER_LIMIT_BYTES,
        retention: {
          jobsDays: settings.JOB_RETENTION_DAYS,
          llmCallsDays: settings.LLM_CALL_RETENTION_DAYS,
          assistantDays: settings.ASSISTANT_RETENTION_DAYS,
          exportsDays: settings.EXPORT_RETENTION_DAYS,
          qualityRunsDays: settings.QUALITY_RUN_RETENTION_DAYS,
          auditMaxEntriesPerProject: settings.AUDIT_MAX_ENTRIES_PER_PROJECT,
        },
      };
    },
  };
}

/** Runs the sweep now and then every `intervalMinutes` (0: never). Returns a stop function. */
export function scheduleRetentionSweep(
  service: RetentionService,
  intervalMinutes: number,
  logger: Logger,
): () => void {
  if (intervalMinutes <= 0) return () => undefined;
  const run = () => {
    service.sweep().catch((error: unknown) => {
      logger.error({ err: error }, 'retention sweep failed');
    });
  };
  const first = setTimeout(run, 0);
  const timer = setInterval(run, intervalMinutes * 60 * 1000);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
