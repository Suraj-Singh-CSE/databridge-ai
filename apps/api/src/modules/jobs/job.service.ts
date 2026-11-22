import type { AiServiceClient } from '../../ai-service.client.js';
import { AppError } from '../../errors.js';
import type { Logger } from '../../logger.js';
import type { Repositories } from '../../repositories.js';
import type { AuditService } from '../audit/audit.service.js';
import type { Actor } from '../projects/project.service.js';
import type { Project } from '../projects/project.types.js';
import type { MappingDecision, MappingSuggestion } from '../mappings/mapping.types.js';
import { isProfiled } from '../sources/source.types.js';
import type { TargetSchemaService } from '../target-schema/target-schema.service.js';

import type { JobEventBus, JobUpdate } from './job.events.js';
import { isTerminal, type Job, type JobType } from './job.types.js';

export interface JobService {
  /** Saves the job (queued) and hands it to the ai-service queue. */
  create(
    actor: Actor,
    project: Project,
    input: { type: JobType; payload: Record<string, unknown> },
  ): Promise<Job>;
  /** The current job, with the stale-worker rule applied; null when it does not exist. */
  find(jobId: string): Promise<Job | null>;
  listByProject(project: Project, limit: number): Promise<Job[]>;
  /** Cancels a queued or running job; a finished job is returned unchanged. */
  cancel(actor: Actor, job: Job): Promise<Job>;
}

export interface JobServiceDeps {
  repos: Pick<Repositories, 'jobs' | 'sources' | 'mappings'>;
  /** Mapping jobs need the project's target schema stored (the default is seeded here). */
  targetSchemas: TargetSchemaService;
  audit: AuditService;
  events: JobEventBus;
  aiService: AiServiceClient;
  logger: Logger;
  staleAfterMs: number;
  now?: () => Date;
}

export const QUEUE_UNAVAILABLE_MESSAGE =
  'The job could not be started because the job queue is unavailable. Please try again shortly.';
const WORKER_LOST = {
  code: 'WORKER_LOST',
  message: 'The worker running this job stopped responding. Please start the job again.',
};

type SourceJobType = 'profile' | 'mapping' | 'standardise';
const SOURCE_JOBS: ReadonlySet<JobType> = new Set<SourceJobType>([
  'profile',
  'mapping',
  'standardise',
]);

const BUSY: Record<SourceJobType, string> = {
  profile:
    'This source is already being profiled. Wait for that job to finish, or cancel it first.',
  mapping:
    'Mapping suggestions for this source are already being made. Wait for that job to finish, or cancel it first.',
  standardise:
    'This source is already being standardised. Wait for that job to finish, or cancel it first.',
};
const NOT_PROFILED: Record<'mapping' | 'standardise', string> = {
  mapping: 'Profile this source first: mapping suggestions are built from its profile.',
  standardise: 'Profile and map this source before standardising it.',
};
const MAPPING_NOT_RUN = 'Run the mapping for this source first, then review it.';

function pendingMessage(count: number): string {
  const noun = count === 1 ? 'column still needs' : 'columns still need';
  return `${count} ${noun} a decision. Accept, reject or change every column's mapping first.`;
}

/** An accept still stands only while the suggestion is the one the reviewer accepted. */
function acceptedAsShown(suggestion: MappingSuggestion, decision: MappingDecision): boolean {
  return (
    suggestion.role === decision.role &&
    suggestion.target === decision.target &&
    suggestion.transform === decision.transform
  );
}

function isSourceJob(type: JobType): type is SourceJobType {
  return SOURCE_JOBS.has(type);
}

export function toUpdate(job: Job): JobUpdate {
  return {
    status: job.status,
    progress: job.progress,
    message: job.message,
    result: job.result,
    error: job.error,
  };
}

export function createJobService({
  repos,
  targetSchemas,
  audit,
  events,
  aiService,
  logger,
  staleAfterMs,
  now = () => new Date(),
}: JobServiceDeps): JobService {
  /** Live updates are best effort: the stream also re-reads MongoDB on every keep-alive. */
  async function announce(job: Job): Promise<void> {
    try {
      await events.publish(job.id, toUpdate(job));
    } catch (error) {
      logger.warn({ jobId: job.id, err: String(error) }, 'job update not published');
    }
  }

  function record(actor: Actor, job: Job, action: string, after: Record<string, unknown>) {
    return audit.record({
      projectId: job.projectId,
      actorId: actor.user.userId,
      action,
      entityType: 'job',
      entityId: job.id,
      after,
      requestId: actor.requestId,
    });
  }

  /**
   * Lazy stale check: a running job whose worker has not sent a heartbeat for staleAfterMs is
   * failed with WORKER_LOST the next time anyone reads it (conditional, so it never overrides
   * a status the worker set meanwhile).
   */
  async function withStaleCheck(job: Job): Promise<Job> {
    if (job.status !== 'running') return job;
    const at = now();
    const cutoff = new Date(at.getTime() - staleAfterMs);
    const lastSeen = job.heartbeatAt ?? job.startedAt ?? job.queuedAt;
    if (lastSeen >= cutoff) return job;
    const failed = await repos.jobs.failIfStale(job.id, cutoff, WORKER_LOST, at);
    if (!failed) return (await repos.jobs.findById(job.id)) ?? job;
    logger.warn({ jobId: job.id }, 'job marked WORKER_LOST');
    await announce(failed);
    return failed;
  }

  /**
   * Standardise needs every column's mapping decided, and every accept still matching the
   * suggestion the reviewer saw (role, target, transform snapshot on the decision): a mapping
   * re-run that changed it means the column must be reviewed again. The worker checks again.
   */
  async function checkMappingReviewed(project: Project, sourceId: string): Promise<void> {
    const [suggestions, decisions] = await Promise.all([
      repos.mappings.listSuggestions(project.id, sourceId),
      repos.mappings.listDecisions(project.id, sourceId),
    ]);
    if (suggestions.length === 0) {
      throw AppError.conflict(MAPPING_NOT_RUN, { reason: 'MAPPING_NOT_RUN' });
    }
    const byColumn = new Map(decisions.map((d) => [d.column, d]));
    const pending = suggestions.filter((s) => !byColumn.has(s.column)).length;
    if (pending > 0) {
      throw AppError.conflict(pendingMessage(pending), { reason: 'MAPPING_NOT_APPROVED', pending });
    }
    const outdated = suggestions
      .filter((s) => {
        const decision = byColumn.get(s.column);
        return decision?.decision === 'accept' && !acceptedAsShown(s.suggestion, decision);
      })
      .map((s) => s.column);
    if (outdated.length > 0) {
      throw AppError.conflict(
        `Mapping changed after review for: ${outdated.join(', ')}. Review these columns again.`,
        { reason: 'DECISION_OUTDATED', columns: outdated },
      );
    }
  }

  /**
   * Source jobs need a source of this project (404 otherwise) that no other job of the same
   * type is working on (409). Mapping and standardise also need the source profiled (409);
   * mapping needs the project's target schema stored, standardise a fully reviewed mapping.
   * The worker checks the source again when it runs.
   */
  async function checkSourceJob(
    project: Project,
    type: SourceJobType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const sourceId = String(payload.sourceId);
    const source = await repos.sources.findById(project.id, sourceId);
    if (!source) throw AppError.notFound('Source not found.');
    if (type !== 'profile' && !isProfiled(source.status)) {
      throw AppError.conflict(NOT_PROFILED[type], { reason: 'SOURCE_NOT_PROFILED' });
    }
    if (type === 'standardise') await checkMappingReviewed(project, sourceId);
    const active = await repos.jobs.listActive(project.id, type);
    const busy = await Promise.all(active.map(withStaleCheck));
    if (busy.some((job) => !isTerminal(job.status) && job.payload.sourceId === sourceId)) {
      throw AppError.conflict(BUSY[type]);
    }
    if (type === 'mapping') await targetSchemas.current(project);
  }

  return {
    async create(actor, project, { type, payload }) {
      if (isSourceJob(type)) await checkSourceJob(project, type, payload);
      const job = await repos.jobs.create({
        projectId: project.id,
        type,
        payload,
        createdBy: actor.user.userId,
      });
      await record(actor, job, 'job.create', { type, payload });
      try {
        await aiService.enqueueJob(
          { jobId: job.id, projectId: project.id, type, payload },
          actor.requestId,
        );
      } catch (error) {
        logger.error({ jobId: job.id, err: String(error) }, 'job enqueue failed');
        const failed = await repos.jobs.finishIfActive(
          job.id,
          {
            status: 'failed',
            message: QUEUE_UNAVAILABLE_MESSAGE,
            error: { code: 'QUEUE_UNAVAILABLE', message: QUEUE_UNAVAILABLE_MESSAGE },
          },
          now(),
        );
        if (failed) await announce(failed);
        throw new AppError(503, 'QUEUE_UNAVAILABLE', QUEUE_UNAVAILABLE_MESSAGE, { jobId: job.id });
      }
      return job;
    },

    async find(jobId) {
      const job = await repos.jobs.findById(jobId);
      return job ? withStaleCheck(job) : null;
    },

    async listByProject(project, limit) {
      const jobs = await repos.jobs.listByProject(project.id, limit);
      return Promise.all(jobs.map(withStaleCheck));
    },

    async cancel(actor, job) {
      if (isTerminal(job.status)) return job;
      const cancelled = await repos.jobs.finishIfActive(
        job.id,
        { status: 'cancelled', message: 'Cancelled', error: null },
        now(),
      );
      // Finished meanwhile: report what it ended as.
      if (!cancelled) return (await repos.jobs.findById(job.id)) ?? job;
      await announce(cancelled);
      await record(actor, cancelled, 'job.cancel', { status: 'cancelled' });
      try {
        await aiService.cancelJob(job.id, actor.requestId);
      } catch (error) {
        // The job is cancelled either way: the worker's next update finds it no longer running.
        logger.warn({ jobId: job.id, err: String(error) }, 'ai-service cancel failed');
      }
      return cancelled;
    },
  };
}
