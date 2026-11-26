import type { ExportFormat } from '../exports/export.types.js';

/** An export past its retention period: enough to delete its file and its metadata. */
export interface ExpiredExport {
  id: string;
  projectId: string;
  format: ExportFormat;
}

/** One collection's approximate size; byte counts are null where the server hides them. */
export interface CollectionUsage {
  name: string;
  documents: number;
  dataBytes: number | null;
  storageBytes: number | null;
  indexBytes: number | null;
}

/**
 * Storage housekeeping for the 512 MB free tier (G3-11, ADR 0029). Jobs, LLM call logs and
 * assistant conversations expire through TTL indexes (src/indexes.ts); the rest is swept here.
 */
export interface RetentionRepository {
  /** Exports created before `cutoff`, oldest first. */
  listExportsBefore(cutoff: Date, limit: number): Promise<ExpiredExport[]>;
  /** Deletes quality reports started before `cutoff`, except each project's newest one. */
  pruneQualityRuns(cutoff: Date): Promise<number>;
  /** Deletes audit entries beyond the newest `maxPerProject` of each project; returns how many. */
  trimAudit(maxPerProject: number): Promise<number>;
  /**
   * Deletes rows of pipeline runs that are neither current nor in progress: staged records,
   * candidate pairs, pair scores, clusters and golden records a crashed job left behind.
   */
  deleteOrphanRuns(): Promise<number>;
  /** Every collection, largest first. */
  collectionUsage(): Promise<CollectionUsage[]>;
}
