/**
 * The profile of one column of a source, written by the ai-service profiler
 * (apps/ai-service/app/profiling, collection `column_profiles`). Values shown here are masked:
 * the profiler never stores raw personal data (docs/adr/0011-column-profiling.md).
 */
export const INFERRED_TYPES = [
  'string',
  'integer',
  'decimal',
  'boolean',
  'date',
  'datetime',
  'email',
  'phone',
  'empty',
] as const;
export type InferredType = (typeof INFERRED_TYPES)[number];

export interface TopValue {
  /** Masked. */
  value: string;
  count: number;
  /** Share of all rows. */
  percent: number;
}

export interface PatternMatch {
  code: string;
  label: string;
  matchCount: number;
  /** Share of non-empty values. */
  matchPercent: number;
}

export interface QualityFlag {
  code: string;
  label: string;
  detail: string;
}

export interface ColumnProfile {
  column: string;
  /** 0-based position in the file. */
  position: number;
  inferredType: InferredType;
  rowCount: number;
  emptyCount: number;
  emptyPercent: number;
  distinctCount: number;
  /** distinct / non-empty values. */
  uniquePercent: number;
  /** Numbers for integer/decimal, ISO text for date/datetime; null otherwise or when personal. */
  min: number | string | null;
  max: number | string | null;
  minLength: number | null;
  maxLength: number | null;
  avgLength: number | null;
  topValues: TopValue[];
  /** Masked. */
  samples: string[];
  patterns: PatternMatch[];
  flags: QualityFlag[];
  /** The column holds personal data (its values above are masked to shapes). */
  personal: boolean;
  profileVersion: number;
  createdAt: Date;
}

export interface ColumnProfileRepository {
  /** In file order. */
  listBySource(projectId: string, sourceId: string): Promise<ColumnProfile[]>;
  deleteBySource(projectId: string, sourceId: string): Promise<number>;
  deleteByProject(projectId: string): Promise<number>;
}
