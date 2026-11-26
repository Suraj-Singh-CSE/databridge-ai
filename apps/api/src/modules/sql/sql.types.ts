export const SQL_STATUSES = ['draft', 'approved', 'rejected', 'superseded'] as const;
export type SqlStatus = (typeof SQL_STATUSES)[number];
export const SQL_METHODS = ['llm', 'reference'] as const;
export type SqlMethod = (typeof SQL_METHODS)[number];
export const SQL_SCOPES = ['approved', 'all'] as const;
export type SqlScope = (typeof SQL_SCOPES)[number];

export interface SqlValidation {
  ok: boolean;
  /** e.g. SQL_NOT_READ_ONLY, SQL_FORBIDDEN_FUNCTION, SQL_UNKNOWN_TABLE (ADR 0021). */
  code: string | null;
  message: string | null;
}

export interface SqlCheck {
  /** columns, row_count, customer_id_unique, customer_id_known, golden_equality, runtime. */
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  message: string;
  /** Counts, percentages and at most a few customer ids: never record values. */
  details: Record<string, unknown>;
}

export interface SqlTestResults {
  passed: boolean;
  checks: SqlCheck[];
  summary: {
    passedCount: number;
    checkCount: number;
    rowCount: number;
    expectedRowCount: number;
    durationMs: number;
  };
}

export interface SqlLastRun {
  runId: string;
  passed: boolean;
  rowCount: number;
  finishedAt: Date;
}

/**
 * One query drafted by the `sql_draft` job (apps/ai-service handlers/sql.py), validated, run in
 * the sandbox and tested there. The id is the job's id. The worker creates it as `draft`; a
 * person approves (only when every test passed) or rejects it here. At most one version per
 * project is `approved`: approving another one supersedes it.
 */
export interface SqlVersion {
  id: string;
  projectId: string;
  jobId: string;
  /** 1, 2, 3 ... per project. */
  version: number;
  sql: string;
  explanation: string;
  assumptions: string[];
  /** `llm`: drafted by the model; `reference`: the hand-written fallback query. */
  method: SqlMethod;
  model: string | null;
  promptVersion: string | null;
  fallbackReason: string | null;
  scope: SqlScope;
  instructions: string | null;
  validation: SqlValidation;
  error: { code: string; message: string } | null;
  tests: SqlTestResults | null;
  testsPassed: boolean;
  /** One entry per draft or repair: validation, error code, passed, failed check names. */
  attempts: Record<string, unknown>[];
  usage: Record<string, number> | null;
  status: SqlStatus;
  createdBy: string | null;
  createdAt: Date;
  clusteringRunId: string;
  schemaVersion: number | null;
  lastRun: SqlLastRun | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  rejectedBy: string | null;
  rejectedAt: Date | null;
  rejectReason: string | null;
  supersededAt: Date | null;
}

export interface SqlVersionRepository {
  /** Newest version first. */
  listByProject(projectId: string, limit: number): Promise<SqlVersion[]>;
  findById(projectId: string, versionId: string): Promise<SqlVersion | null>;
  /** The project's approved version (a partial unique index keeps at most one, G3-13). */
  findApproved(projectId: string): Promise<SqlVersion | null>;
  /**
   * Draft -> approved, only while it is still a draft whose tests passed; the approved version
   * of the project becomes `superseded` first, so there is never more than one (G3-13), and a
   * simultaneous approval is retried. Null when the condition no longer held (someone else
   * decided first); the previous approval is then put back.
   */
  approve(
    projectId: string,
    versionId: string,
    by: string,
    at: Date,
  ): Promise<{ version: SqlVersion; superseded: number[] } | null>;
  /** Draft or approved -> rejected. Null when it was neither any more. */
  reject(
    projectId: string,
    versionId: string,
    by: string,
    at: Date,
    reason: string | null,
  ): Promise<SqlVersion | null>;
  deleteByProject(projectId: string): Promise<void>;
}
