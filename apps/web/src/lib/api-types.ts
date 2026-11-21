/**
 * Shapes returned by apps/api (/api/v1), as JSON. Keep in step with
 * apps/api/src/modules/{users,projects,sources,jobs}/*.types.ts. Dates arrive as ISO strings.
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
export type SourceStatus = 'uploaded' | 'profiling' | 'profiled' | 'ready' | 'failed';

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
  uploadedBy: string;
  createdAt: string;
  updatedAt: string;
}

/** First rows of a source (raw values, shown only to project members). */
export interface SourcePreview {
  columns: string[];
  rows: string[][];
}

export type JobType = 'demo' | 'profile';
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
