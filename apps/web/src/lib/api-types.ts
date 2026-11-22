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
  | 'clustering';
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
  settings: { includeAiSuggested: boolean; maxClusterSize: number; sourceTrust: string[] };
  finishedAt: string;
}

export interface ClusterSummaryView {
  summary: ClusterSummary;
  /** True when the pairs were scored or reviewed again, or the scores are themselves outdated. */
  outdated: boolean;
}

export interface ClusterPage extends ClusterSummaryView {
  items: ClusterView[];
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
}

export interface ClusterDetail extends ClusterSummaryView {
  cluster: ClusterView;
}
