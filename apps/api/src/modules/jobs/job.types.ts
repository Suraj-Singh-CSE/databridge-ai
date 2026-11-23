/** Every type has a payload schema in job.schemas.ts and a handler in apps/ai-service. */
export const JOB_TYPES = [
  'demo',
  'profile',
  'mapping',
  'standardise',
  'candidates',
  'scoring',
  'pair_review',
  'clustering',
  'export',
  'sql_draft',
  'sql_run',
  'quality',
  'knowledge_index',
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

const TERMINAL: ReadonlySet<JobStatus> = new Set(['succeeded', 'failed', 'cancelled']);

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL.has(status);
}

export interface JobError {
  code: string;
  message: string;
}

/**
 * Background work in a project. The api creates the record; the worker (apps/ai-service) moves
 * it to running and to its final status. Payload and result are small JSON, never record values.
 */
export interface Job {
  id: string;
  projectId: string;
  type: JobType;
  status: JobStatus;
  /** 0-100. */
  progress: number;
  /** Short plain-language text about the current step. */
  message: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: JobError | null;
  /** Attempts started by a worker (retries included). */
  attempts: number;
  createdBy: string;
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** Last sign of life from the worker; see JOB_STALE_AFTER_SECONDS. */
  heartbeatAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewJob {
  projectId: string;
  type: JobType;
  payload: Record<string, unknown>;
  createdBy: string;
}

export interface JobEnding {
  status: 'failed' | 'cancelled';
  message: string;
  error: JobError | null;
}

export interface JobRepository {
  create(input: NewJob): Promise<Job>;
  findById(id: string): Promise<Job | null>;
  /** Newest first. */
  listByProject(projectId: string, limit: number): Promise<Job[]>;
  /** Queued or running jobs of one type in a project. */
  listActive(projectId: string, type: JobType): Promise<Job[]>;
  /**
   * Ends the job only while it is queued or running (status never moves backwards).
   * Returns the updated job, or null when it had already ended (or does not exist).
   */
  finishIfActive(id: string, ending: JobEnding, at: Date): Promise<Job | null>;
  /** Like finishIfActive, but only for a running job whose last heartbeat is before `cutoff`. */
  failIfStale(id: string, cutoff: Date, error: JobError, at: Date): Promise<Job | null>;
  deleteByProject(projectId: string): Promise<number>;
}
