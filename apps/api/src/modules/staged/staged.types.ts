/**
 * Staged records: every row of a source after the reviewed mapping and cleaning were applied
 * (`staged_records`, written by apps/ai-service/app/standardise/store.py). See ADR 0014.
 */
export interface StagedIssue {
  field: string;
  /** Plain issue code, e.g. `INVALID_PHONE`, `UNPARSEABLE_DATE`. */
  code: string;
}

export interface StagedRecord {
  /** 1-based position among the file's data rows (blank lines skipped). */
  rowNumber: number;
  /** The source system's own id for the row (lineage), when a column has that role. */
  sourceRecordId: string | null;
  /** Target field -> cleaned value (null: empty at the source or refused by a cleaner). */
  fields: Record<string, string | null>;
  issues: StagedIssue[];
}

export interface StagedPageQuery {
  runId: string;
  /** Rows after this row number. */
  afterRow: number;
  limit: number;
  issuesOnly: boolean;
}

export interface StagedRecordRepository {
  /** One run's rows in row order. */
  list(projectId: string, sourceId: string, query: StagedPageQuery): Promise<StagedRecord[]>;
  deleteBySource(projectId: string, sourceId: string): Promise<void>;
  deleteByProject(projectId: string): Promise<void>;
}
