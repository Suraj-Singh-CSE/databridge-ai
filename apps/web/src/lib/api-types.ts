/**
 * Shapes returned by apps/api (/api/v1), as JSON. Keep in step with
 * apps/api/src/modules/{users,projects,sources,jobs,candidates,scores,clusters}/*.types.ts (and the
 * service views). Dates arrive as ISO strings.
 */

export const ROLES = ['admin', 'data_engineer', 'data_steward', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
  updatedAt: string;
}

/** Body of register, login and refresh responses. */
export interface AuthSession {
  user: User;
  accessToken: string;
}

export const PROJECT_STEPS = [
  'sources',
  'profile',
  'mapping',
  'matching',
  'pipeline',
  'quality',
] as const;
export type ProjectStep = (typeof PROJECT_STEPS)[number];

export type ProjectStatus = 'active' | 'archived';
export type ProjectRole = 'data_engineer' | 'data_steward' | 'viewer';

export interface Project {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  members: { userId: string; role: ProjectRole }[];
  status: ProjectStatus;
  currentStep: ProjectStep;
  createdAt: string;
  updatedAt: string;
}

export interface Page<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
}

/** Error codes the api can return, plus NETWORK_ERROR for requests that never got an answer. */
export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'TOO_MANY_ROWS'
  | 'UNSUPPORTED_FILE'
  | 'FILE_TOO_COMPLEX'
  | 'LIMIT_REACHED'
  | 'RATE_LIMITED'
  | 'QUEUE_UNAVAILABLE'
  | 'INTERNAL_ERROR'
  | 'NETWORK_ERROR';

/** `details` of a VALIDATION_ERROR. */
export interface FieldIssue {
  field: string;
  message: string;
}

export type SourceFormat = 'csv' | 'xlsx';
/** `profiling` -> `profiled` | `failed` are set by the profiler (ADR 0011). */
export type SourceStatus =
  'uploaded' | 'profiling' | 'profiled' | 'standardised' | 'ready' | 'failed';

/** Counts from the last standardise run (written by the worker). Never values. */
export interface StandardisationSummary {
  /** `<jobId>:<attempt>` whose rows are in staged_records. */
  runId: string;
  rowCount: number;
  rowsWithIssues: number;
  issues: { code: string; count: number }[];
}

/** An uploaded file: metadata only, never row values. */
export interface Source {
  id: string;
  projectId: string;
  name: string;
  systemName: string | null;
  originalFilename: string;
  format: SourceFormat;
  sizeBytes: number;
  sha256: string;
  status: SourceStatus;
  rowCount: number | null;
  columnCount: number | null;
  error: { code: string; message: string } | null;
  profiledAt: string | null;
  /** When the last successful standardise run finished. */
  standardisedAt: string | null;
  /** Kept after a re-profile (status back to `profiled`): the cleaned rows are then outdated. */
  standardisation: StandardisationSummary | null;
  uploadedBy: string;
  createdAt: string;
  updatedAt: string;
}

/** First rows of a source (raw values, shown only to project members). */
export interface SourcePreview {
  columns: string[];
  rows: string[][];
}

export type JobType =
  | 'demo'
  | 'profile'
  | 'mapping'
  | 'standardise'
  | 'candidates'
  | 'scoring'
  | 'pair_review'
  | 'clustering'
  | 'export'
  | 'sql_draft'
  | 'sql_run'
  | 'quality';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface JobError {
  code: string;
  message: string;
}

export interface Job {
  id: string;
  projectId: string;
  type: JobType;
  status: JobStatus;
  /** 0-100. */
  progress: number;
  message: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: JobError | null;
  createdAt: string;
  updatedAt: string;
}

/** One `event: job` frame of GET /jobs/:jobId/events. */
export interface JobUpdate {
  jobId: string;
  status: JobStatus;
  progress: number;
  message: string;
  result: Record<string, unknown> | null;
  error: JobError | null;
}

export type InferredType =
  'string' | 'integer' | 'decimal' | 'boolean' | 'date' | 'datetime' | 'email' | 'phone' | 'empty';

/** Column profile written by the ai-service profiler. Values are masked (ADR 0011). */
export interface ColumnProfile {
  column: string;
  position: number;
  inferredType: InferredType;
  rowCount: number;
  emptyCount: number;
  emptyPercent: number;
  distinctCount: number;
  uniquePercent: number;
  min: number | string | null;
  max: number | string | null;
  minLength: number | null;
  maxLength: number | null;
  avgLength: number | null;
  /** Masked. `percent` is the share of all rows. */
  topValues: { value: string; count: number; percent: number }[];
  /** Masked. */
  samples: string[];
  patterns: { code: string; label: string; matchCount: number; matchPercent: number }[];
  flags: { code: string; label: string; detail: string }[];
  personal: boolean;
}

export interface SourceProfile {
  source: Source;
  /** Empty until the source has been profiled. */
  columns: ColumnProfile[];
}

/** Target schema field (apps/api target-schema.types.ts). */
export type TargetFieldType = 'string' | 'integer' | 'decimal' | 'boolean' | 'date' | 'datetime';

export interface TargetField {
  name: string;
  type: TargetFieldType;
  /** Expected format in plain words, e.g. "YYYY-MM-DD". */
  format: string | null;
  description: string;
  isPii: boolean;
  /** Created by DataBridge (e.g. customer_id); never mapped from a source column. */
  generated: boolean;
  required: boolean;
  allowConcat: boolean;
}

export interface TargetSchema {
  name: string;
  version: number;
  fields: TargetField[];
  updatedBy: string | null;
  updatedAt: string;
}

/** Column mapping (apps/api mappings module, ADR 0012). */
export type MappingRole = 'field' | 'source_record_id' | 'ignore';
export type ConfidenceLabel = 'High' | 'Medium' | 'Low';
export type MappingMethod = 'hybrid' | 'rules';
export type MappingDecisionKind = 'accept' | 'reject' | 'override';
export type MappingStatus = 'pending' | 'accepted' | 'rejected' | 'overridden';

export interface MappingAlternative {
  target: string | null;
  role: MappingRole;
  confidence: number;
}

/** The engine's proposal for one column. `target` is null unless `role` is `field`. */
export interface MappingSuggestion {
  target: string | null;
  role: MappingRole;
  /** 0-1. */
  confidence: number;
  confidenceLabel: ConfidenceLabel;
  reason: string;
  /** Hint for the cleaning step, e.g. `to_e164_in`, `parse_date:DD/MM/YYYY`. */
  transform: string | null;
  alternatives: MappingAlternative[];
}

export interface MappingRun {
  jobId: string;
  runId: string;
  schemaVersion: number;
  /** `rules` when the AI step failed or was off. */
  method: MappingMethod;
  model: string | null;
  createdAt: string;
}

export interface MappingDecision {
  column: string;
  decision: MappingDecisionKind;
  target: string | null;
  role: MappingRole;
  transform: string | null;
  schemaVersion: number;
  decidedBy: string;
  decidedAt: string;
}

export interface ColumnMapping {
  column: string;
  position: number;
  suggestion: MappingSuggestion;
  decision: MappingDecision | null;
  status: MappingStatus;
}

export interface SourceMappings {
  source: Pick<Source, 'id' | 'name' | 'status'>;
  schemaVersion: number;
  /** Null before the first mapping job. */
  run: MappingRun | null;
  /** True when the target schema changed after the suggestions were made. */
  stale: boolean;
  columns: ColumnMapping[];
  summary: { total: number; high: number; medium: number; low: number; decided: number };
}

/** Result of "accept all High" (apps/api mapping.service.ts). */
export interface AcceptHighResult {
  accepted: number;
  alreadyDecided: number;
  conflicts: number;
}

/** A cleaned row (apps/api staged.types.ts), looked up by id with its source's name. */
export interface CandidateRecord {
  id: string;
  sourceId: string;
  sourceName: string;
  /** 1-based position among the file's data rows. */
  rowNumber: number;
  /** The source system's own id for the row, when a column has that role. */
  sourceRecordId: string | null;
  /** Target field -> cleaned value. */
  fields: Record<string, string | null>;
  issues: { field: string; code: string }[];
}

export interface KeyCount {
  key: string;
  count: number;
}

/** Candidate pairs (apps/api candidates module, ADR 0015): the last successful run. */
export interface CandidateSummary {
  jobId: string;
  runId: string;
  sources: { sourceId: string; runId: string; rowCount: number }[];
  recordCount: number;
  possiblePairs: number;
  pairCount: number;
  reductionRatio: number;
  pairsByKey: KeyCount[];
  pairsOnlyByKey: KeyCount[];
  oversizeBlocksSkipped: number;
  oversizeBlocksByKey: KeyCount[];
  maxBlockSize: number;
  finishedAt: string;
}

export interface CandidateSummaryView {
  summary: CandidateSummary;
  /** True when a source was cleaned again, re-profiled or added since this run. */
  outdated: boolean;
}

/** Pair scores (apps/api scores module, ADR 0016). */
export type ScoreBand = 'match' | 'maybe' | 'non_match';

export interface ScoreModelLevel {
  level: string;
  m: number;
  u: number;
  weight: number;
}

export interface ScoreModel {
  method: 'em' | 'defaults';
  emIterations: number;
  emConverged: boolean;
  fallbackReason: string | null;
  matchProportion: number;
  priorWeight: number;
  fields: { field: string; levels: ScoreModelLevel[] }[];
}

/** Counts of the last `pair_review` run on this scoring run (ADR 0017). */
export interface AiReviewSummary {
  jobId: string;
  promptVersion: string;
  model: string | null;
  confidenceThreshold: number;
  pairCount: number;
  reviewed: number;
  same: number;
  different: number;
  unsure: number;
  unavailable: number;
  suggestedMatch: number;
  suggestedNonMatch: number;
  calls: number;
  failedCalls: number;
  finishedAt: string;
}

export interface ScoreSummary {
  jobId: string;
  runId: string;
  candidatesRunId: string;
  pairCount: number;
  bandCounts: { band: ScoreBand; count: number }[];
  thresholds: { match: number; maybe: number };
  model: ScoreModel;
  finishedAt: string;
  /** null until the AI has reviewed this run's maybe pairs. */
  aiReview: AiReviewSummary | null;
}

export interface ScoreSummaryView {
  summary: ScoreSummary;
  /** True when the candidate pairs were found again, or are themselves outdated. */
  outdated: boolean;
}

/** Clusters and golden records (apps/api clusters module, ADR 0018). */
export type ClusterStatus = 'proposed' | 'approved' | 'rejected';
export type ClusterFlag =
  'needs_review' | 'different_people' | 'conflicting_evidence' | 'too_large';
export type LinkKind = 'match' | 'ai_suggested' | 'human';
export type SurvivorshipRule =
  | 'only_value'
  | 'most_frequent'
  | 'most_complete'
  | 'most_typical'
  | 'source_trust'
  | 'most_recent'
  | 'row_order';

/** A scored pair (or a person's decision) that holds two members together. */
export interface ClusterLink {
  recordA: string;
  recordB: string;
  score: number;
  kind: LinkKind;
  /** On the cluster's maximum spanning tree: the links it cannot do without. */
  tree: boolean;
}

export interface FieldAlternative {
  value: string;
  count: number;
  recordIds: string[];
  sources: string[];
}

/** Where one golden value came from. */
export interface FieldProvenance {
  /** null when no member has the field. */
  recordId: string | null;
  /** The source's name. */
  source: string | null;
  rule: SurvivorshipRule | null;
  /** Every distinct value among the members, the chosen one first. */
  alternatives: FieldAlternative[];
}

export interface GoldenRecord {
  customerId: string;
  status: ClusterStatus;
  fields: Record<string, string | null>;
  provenance: Record<string, FieldProvenance>;
}

export interface Cluster {
  position: number;
  customerId: string;
  memberRecordIds: string[];
  size: number;
  /** Weakest score on the spanning tree; null for a single record. */
  confidence: number | null;
  label: ConfidenceLabel | null;
  status: ClusterStatus;
  flags: ClusterFlag[];
  /** Plain-language reasons for the flags; never values. */
  reasons: string[];
  aiSuggested: boolean;
  links: ClusterLink[];
}

export interface ClusterView extends Cluster {
  /** In `memberRecordIds` order; null when a record is gone. */
  members: (CandidateRecord | null)[];
  goldenRecord: GoldenRecord | null;
  /** Set while a person's approval matches this exact membership (ADR 0019). */
  approval: { approvedBy: string; approvedAt: string } | null;
  /** Not approved, but some member was in a group a person approved: the membership changed. */
  membershipChanged: boolean;
}

/** The scored pair behind a link; null for a link a person made. */
export interface LinkEvidence {
  score: number;
  band: ScoreBand;
  reasons: { field: string; level: string; weight: number; text: string }[];
  aiDecision: 'same' | 'different' | 'unsure' | null;
  aiConfidence: number | null;
  aiReason: string | null;
  suggestedBand: ScoreBand;
}

export interface ClusterDetailView extends ClusterView {
  links: (ClusterLink & { evidence: LinkEvidence | null })[];
}

export interface ClusterReviewCounts {
  approvedCount: number;
  proposedCount: number;
  /** What "Approve all High" would approve now. */
  approvableHighCount: number;
  sameDecisionCount: number;
  differentDecisionCount: number;
}

export interface ApproveHighResult {
  approved: number;
  alreadyApproved: number;
}

/** Split and merge: the decision is saved, and a clustering job applies it. */
export interface ReclusterResult {
  decisionsWritten: number;
  job: Job | null;
  /** Why the job did not start; null when it did. */
  jobMessage: string | null;
}

export interface ClusterSummary {
  jobId: string;
  runId: string;
  scoresRunId: string;
  candidatesRunId: string;
  aiReviewJobId: string | null;
  recordCount: number;
  clusterCount: number;
  singletonCount: number;
  multiRecordCount: number;
  needsReviewCount: number;
  aiSuggestedCount: number;
  averageSize: number;
  largestCluster: number;
  decisionCount: number;
  /** Decisions naming a record that no longer exists: they no longer apply. */
  staleDecisionCount: number;
  cutLinkCount: number;
  conflictingDecisionCount: number;
  settings: { includeAiSuggested: boolean; maxClusterSize: number; sourceTrust: string[] };
  finishedAt: string;
}

export interface ClusterSummaryView {
  summary: ClusterSummary;
  /** True when the pairs were scored or reviewed again, or the scores are themselves outdated. */
  outdated: boolean;
  review: ClusterReviewCounts;
}

export interface ClusterPage extends ClusterSummaryView {
  items: ClusterView[];
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
}

export interface ClusterDetail extends ClusterSummaryView {
  cluster: ClusterDetailView;
}

/* ---------- SQL pipeline (apps/api modules/sql, ADR 0021) ---------- */

export type SqlStatus = 'draft' | 'approved' | 'rejected' | 'superseded';
export type SqlMethod = 'llm' | 'reference';
export type DataScope = 'approved' | 'all';

export interface SqlValidation {
  ok: boolean;
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
  finishedAt: string;
}

/** A version as the list returns it: everything but the query text and the attempt log. */
export interface SqlVersionSummary {
  id: string;
  projectId: string;
  jobId: string;
  version: number;
  explanation: string;
  assumptions: string[];
  method: SqlMethod;
  model: string | null;
  promptVersion: string | null;
  fallbackReason: string | null;
  scope: DataScope;
  instructions: string | null;
  validation: SqlValidation;
  error: { code: string; message: string } | null;
  tests: SqlTestResults | null;
  testsPassed: boolean;
  usage: Record<string, number> | null;
  status: SqlStatus;
  createdBy: string | null;
  createdAt: string;
  clusteringRunId: string;
  schemaVersion: number | null;
  lastRun: SqlLastRun | null;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedBy: string | null;
  rejectedAt: string | null;
  rejectReason: string | null;
  supersededAt: string | null;
}

export interface SqlVersion extends SqlVersionSummary {
  sql: string;
  attempts: Record<string, unknown>[];
}

/* ---------- Exports (apps/api modules/exports, ADR 0020) ---------- */

export type ExportFormat = 'csv' | 'xlsx';

export interface ExportView {
  id: string;
  projectId: string;
  jobId: string;
  format: ExportFormat;
  scope: DataScope;
  includeSources: boolean;
  rowCount: number;
  bytes: number;
  sha256: string;
  clusteringRunId: string;
  schemaVersion: number | null;
  status: 'ready';
  createdBy: string | null;
  createdAt: string;
  filename: string;
}

/* ---------- Data quality (apps/api modules/quality, ADR 0022) ---------- */

export type QualityStatus = 'pass' | 'warn' | 'fail' | 'skipped';

export interface QualityThreshold {
  warn: number;
  /** null: the rule never fails, it can only warn. */
  fail: number | null;
}

export interface QualityResult {
  rule: string;
  label: string;
  field: string | null;
  status: QualityStatus;
  metric: number | null;
  unit: 'percent' | 'hours';
  direction: 'min' | 'max';
  threshold: QualityThreshold | null;
  message: string;
  /** Counts only, never values. */
  counts: Record<string, number>;
  /** At most 10 customer ids, never values. */
  exampleIds: string[];
}

export interface QualitySource {
  kind: 'sql_version' | 'golden_records';
  label: string;
  versionId: string | null;
  version: number | null;
  scope: DataScope;
  sqlTestsPassed: boolean;
  failedChecks: string[];
}

export interface QualityRunSummary {
  id: string;
  projectId: string;
  jobId: string;
  startedAt: string;
  finishedAt: string;
  source: QualitySource;
  clusteringRunId: string;
  schemaVersion: number | null;
  rowCount: number;
  /** The worst rule status (skipped rules do not count). */
  status: Exclude<QualityStatus, 'skipped'>;
  statusCounts: Record<QualityStatus, number>;
  ruleCount: number;
  createdBy: string | null;
}

export interface QualityRun extends QualityRunSummary {
  results: QualityResult[];
  /** The effective thresholds the run used (defaults plus overrides). */
  config: Record<string, unknown>;
}

export interface QualityRuleOverride {
  enabled?: boolean;
  warn?: number;
  fail?: number | null;
}

export interface QualityRulesView {
  rules: Partial<Record<string, QualityRuleOverride>>;
  fields: Record<string, { warn?: number; fail?: number | null }>;
  updatedBy: string | null;
  updatedAt: string | null;
  catalogue: { rule: string; direction: 'min' | 'max'; max: number }[];
}

/* ---------- Dashboard (apps/api dashboard.service.ts, ADR 0023) ---------- */

export const DASHBOARD_RANGES = ['7d', '30d', '90d'] as const;
export type DashboardRange = (typeof DASHBOARD_RANGES)[number];

export interface DashboardPipeline {
  sources: { count: number; byStatus: Record<SourceStatus, number>; rowsUploaded: number };
  mapping: {
    sourcesMapped: number;
    columns: number;
    decided: number;
    pending: number;
    sourcesOnRules: number;
    outdated: boolean;
  };
  standardise: { sources: number; rows: number; rowsWithIssues: number; outdated: boolean };
  candidates: { ran: boolean; pairs: number; outdated: boolean };
  scores: { ran: boolean; pairs: number; byBand: Record<ScoreBand, number>; outdated: boolean };
  aiReview: { ran: boolean; pairs: number; reviewed: number; unavailable: number };
  clusters: {
    ran: boolean;
    customers: number;
    multiRecord: number;
    recordsMerged: number;
    needsReview: number;
    approved: number;
    proposed: number;
    outdated: boolean;
  };
  sql: {
    latest: { version: number; status: SqlStatus; testsPassed: boolean; method: SqlMethod } | null;
    approvedVersion: number | null;
    outdated: boolean;
  };
  exports: { count: number; outdated: boolean };
  quality: {
    latest: { status: Exclude<QualityStatus, 'skipped'>; at: string } | null;
    outdated: boolean;
  };
  nextStep: { text: string; step: ProjectStep };
}

export interface DashboardQuality {
  runs: {
    at: string;
    status: Exclude<QualityStatus, 'skipped'>;
    pass: number;
    warn: number;
    fail: number;
  }[];
  latestRules: {
    rule: string;
    field: string | null;
    label: string;
    status: QualityStatus;
    metric: number | null;
    unit: 'percent' | 'hours';
  }[];
}

export interface DashboardAiTotals {
  calls: number;
  ok: number;
  failed: number;
  failedBy: {
    status: string | null;
    httpCode: number | null;
    errorType: string | null;
    count: number;
  }[];
  cacheHits: number;
  schemaFallbacks: number;
  inputTokens: number;
  outputTokens: number;
  costInr: number;
  costLabel: 'free tier' | 'paid';
  latencyMs: { p50: number | null; p95: number | null; samples: number };
  models: string[];
}

export interface DashboardAiTask extends DashboardAiTotals {
  task: string;
}

export interface DashboardAi {
  tasks: DashboardAiTask[];
  total: DashboardAiTotals;
  fallbacks: {
    mappingSourcesOnRules: number;
    sqlReferenceVersions: number;
    pairReviewUnavailable: number;
  };
  daily: { date: string; calls: number; tokens: number; costInr: number }[];
}

export const REVIEW_TYPES = [
  'mapping_accept',
  'mapping_reject',
  'mapping_override',
  'mapping_accept_high',
  'match_approve',
  'match_approve_high',
  'match_split',
  'match_merge',
  'match_undo',
  'sql_approve',
  'sql_reject',
  'quality_rules_change',
] as const;
export type ReviewType = (typeof REVIEW_TYPES)[number];
export type ReviewerRole = 'owner' | ProjectRole | 'admin' | 'former_member';

export interface DashboardReview {
  total: number;
  byType: Record<ReviewType, number>;
  byRole: Partial<Record<ReviewerRole, number>>;
  medianTimeToDecisionMs: Partial<
    Record<'mapping' | 'match_approve' | 'sql', { medianMs: number; samples: number }>
  >;
}

export interface DashboardJobType {
  type: JobType;
  total: number;
  succeeded: number;
  failed: number;
  failedBy: { code: string; count: number }[];
  cancelled: number;
  active: number;
  durationMs: { median: number | null; p95: number | null };
}

export interface DashboardJobs {
  byType: DashboardJobType[];
  recentFailures: { type: JobType; code: string | null; at: string }[];
}

export interface BenchmarkMetric {
  name: string;
  value: number;
  unit: 'percent' | 'count';
  display: string;
}

export interface Benchmark {
  id: string;
  title: string;
  dataset: 'synthetic';
  set: string;
  source: string;
  measuredOn: string;
  metrics: BenchmarkMetric[];
  evidence: string[];
}

export interface Dashboard {
  range: { key: DashboardRange; days: number; since: string; until: string };
  pipeline: DashboardPipeline;
  quality: DashboardQuality;
  ai: DashboardAi;
  review: DashboardReview;
  jobs: DashboardJobs;
  benchmarks: { version: number; items: Benchmark[] };
}
