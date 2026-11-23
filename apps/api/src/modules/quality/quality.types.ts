import type { PageRequest } from '../../http.js';

/**
 * The configurable quality rules (apps/ai-service app/quality/config.py, ADR 0022): `min`
 * rules warn or fail below a threshold (a percentage that should be high), `max` rules above
 * it (hours, a percentage change, a share that should be low). `customer_id_unique` is fixed.
 * Default thresholds live in the worker; the api stores and validates a project's overrides.
 */
export const QUALITY_RULES = {
  completeness_required: { direction: 'min', max: 100 },
  completeness_optional: { direction: 'min', max: 100 },
  validity: { direction: 'min', max: 100 },
  phone_shared: { direction: 'max', max: 100 },
  email_shared: { direction: 'max', max: 100 },
  city_pin_consistency: { direction: 'min', max: 100 },
  clustering_freshness: { direction: 'max', max: 8760 },
  sql_run_freshness: { direction: 'max', max: 8760 },
  row_count_change: { direction: 'max', max: 1000 },
} as const satisfies Record<string, { direction: 'min' | 'max'; max: number }>;
export type QualityRuleId = keyof typeof QUALITY_RULES;
export const MAX_FIELD_OVERRIDES = 50;

export const QUALITY_STATUSES = ['pass', 'warn', 'fail', 'skipped'] as const;
export type QualityStatus = (typeof QUALITY_STATUSES)[number];

export interface RuleOverride {
  enabled?: boolean | undefined;
  warn?: number | undefined;
  /** `null`: the rule never fails, it can only warn. */
  fail?: number | null | undefined;
}

export interface FieldOverride {
  warn?: number | undefined;
  fail?: number | null | undefined;
}

export interface QualityRuleOverrides {
  rules: Partial<Record<QualityRuleId, RuleOverride | undefined>>;
  /** Completeness thresholds of single fields (on top of the required/optional rule). */
  fields: Record<string, FieldOverride>;
}

export interface QualityRules extends QualityRuleOverrides {
  updatedBy: string | null;
  updatedAt: Date | null;
}

export interface QualityResult {
  rule: string;
  label: string;
  field: string | null;
  status: QualityStatus;
  metric: number | null;
  unit: 'percent' | 'hours';
  direction: 'min' | 'max';
  threshold: { warn: number; fail: number | null } | null;
  message: string;
  /** Counts only, never values. */
  counts: Record<string, number>;
  /** At most 10 customer ids, never values. */
  exampleIds: string[];
}

export interface QualitySource {
  /** `sql_version`: the approved SQL; `golden_records`: no approved SQL, golden records used. */
  kind: 'sql_version' | 'golden_records';
  label: string;
  versionId: string | null;
  version: number | null;
  scope: 'approved' | 'all';
  sqlTestsPassed: boolean;
  failedChecks: string[];
}

/** One `quality` job's report (written by apps/ai-service handlers/quality.py). */
export interface QualityRun {
  id: string;
  projectId: string;
  jobId: string;
  startedAt: Date;
  finishedAt: Date;
  source: QualitySource;
  clusteringRunId: string;
  schemaVersion: number | null;
  rowCount: number;
  /** The worst rule status (skipped rules do not count). */
  status: Exclude<QualityStatus, 'skipped'>;
  statusCounts: Record<QualityStatus, number>;
  ruleCount: number;
  results: QualityResult[];
  /** The effective thresholds the run used (defaults plus overrides). */
  config: Record<string, unknown>;
  createdBy: string | null;
}

export type QualityRunSummary = Omit<QualityRun, 'results' | 'config'>;

export interface QualityRepository {
  /** Newest first. */
  listRuns(
    projectId: string,
    page: PageRequest,
  ): Promise<{ items: QualityRunSummary[]; total: number }>;
  findRun(projectId: string, runId: string): Promise<QualityRun | null>;
  latestRun(projectId: string): Promise<QualityRun | null>;
  findRules(projectId: string): Promise<QualityRules | null>;
  saveRules(
    projectId: string,
    overrides: QualityRuleOverrides,
    by: string,
    at: Date,
  ): Promise<QualityRules>;
  deleteByProject(projectId: string): Promise<void>;
}
