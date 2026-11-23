import type { JobStatus, JobType } from '../jobs/job.types.js';
import type { QualityStatus } from '../quality/quality.types.js';

/**
 * Project dashboard (ADR 0023): counts and timings aggregated from the other modules. Never a
 * record value: only counts, statuses, durations, token and cost totals, and source names.
 */
export const DASHBOARD_RANGES = { '7d': 7, '30d': 30, '90d': 90 } as const;
export type DashboardRange = keyof typeof DASHBOARD_RANGES;

/** Mapping suggestions and decisions of one source. */
export interface MappingSourceCounts {
  sourceId: string;
  /** Columns with a suggestion. */
  columns: number;
  /** Decisions stored for the source (one per column at most). */
  decisions: number;
  /** Target schema version the newest suggestions were made for. */
  schemaVersion: number;
  /** The newest run used the deterministic rules only (the LLM step failed or was off). */
  rulesOnly: boolean;
}

/** Audit entries of one action (and, for `mapping.decide`, one decision) by one person. */
export interface AuditCount {
  action: string;
  /** `after.decision` (`accept`, `reject`, `override`) for `mapping.decide`; otherwise null. */
  decision: string | null;
  actorId: string;
  count: number;
}

export interface JobCount {
  type: JobType;
  status: JobStatus;
  errorCode: string | null;
  count: number;
}

export interface JobDurations {
  type: JobType;
  /** Succeeded jobs only (finishedAt - startedAt), ascending. */
  durationsMs: number[];
}

export interface JobFailure {
  type: JobType;
  code: string | null;
  at: Date;
}

export interface JobStats {
  counts: JobCount[];
  durations: JobDurations[];
  /** Newest first, at most 5. */
  failures: JobFailure[];
}

/**
 * The fields of an `llm_calls` document the dashboard reads (written by the ai-service gateway,
 * apps/ai-service/app/llm/cost.py `LLMCallRecord`; stored in snake_case). Never prompt text.
 */
export interface LlmCall {
  projectId: string | null;
  task: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costInr: number;
  latencyMs: number;
  cacheHit: boolean;
  outcome: 'ok' | 'error';
  errorType: string | null;
  errorCode: number | null;
  errorStatus: string | null;
  schemaFallback: boolean;
  createdAt: Date;
}

export interface LlmTaskTotals {
  task: string;
  calls: number;
  ok: number;
  cacheHits: number;
  schemaFallbacks: number;
  inputTokens: number;
  outputTokens: number;
  costInr: number;
  models: string[];
  /** Successful calls answered by the provider (cache hits excluded), ascending. */
  latenciesMs: number[];
}

export interface LlmErrorCount {
  task: string;
  status: string | null;
  httpCode: number | null;
  errorType: string | null;
  count: number;
}

export interface LlmDay {
  /** UTC day, YYYY-MM-DD. */
  date: string;
  calls: number;
  tokens: number;
  costInr: number;
}

export interface LlmStats {
  tasks: LlmTaskTotals[];
  errors: LlmErrorCount[];
  days: LlmDay[];
}

export interface QualityPoint {
  at: Date;
  status: Exclude<QualityStatus, 'skipped'>;
  pass: number;
  warn: number;
  fail: number;
}

/** Range-bound aggregates the existing repositories have no method for. */
export interface DashboardRepository {
  mappingBySource(projectId: string): Promise<MappingSourceCounts[]>;
  /** For decisions made since `since`: decidedAt - the suggestion's createdAt (>= 0 only). */
  mappingDecisionLagsMs(projectId: string, since: Date): Promise<number[]>;
  countExports(projectId: string): Promise<number>;
  auditCounts(projectId: string, since: Date, actions: readonly string[]): Promise<AuditCount[]>;
  /** Jobs created since `since`. */
  jobStats(projectId: string, since: Date): Promise<JobStats>;
  llmStats(projectId: string, since: Date): Promise<LlmStats>;
  /** Quality runs started since `since`, oldest first; the newest `limit` when there are more. */
  qualitySeries(projectId: string, since: Date, limit: number): Promise<QualityPoint[]>;
}
