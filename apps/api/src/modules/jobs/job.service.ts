import type { AiServiceClient } from '../../ai-service.client.js';
import { AppError } from '../../errors.js';
import type { Logger } from '../../logger.js';
import type { Repositories } from '../../repositories.js';
import type { AuditService } from '../audit/audit.service.js';
import { candidatesOutdated } from '../candidates/candidate.service.js';
import { currentClusters } from '../clusters/cluster.service.js';
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
  /** A job of this type is queued or running in the project (stale workers excluded). */
  hasActive(project: Project, type: JobType): Promise<boolean>;
}

export interface JobServiceDeps {
  repos: Pick<
    Repositories,
    | 'jobs'
    | 'sources'
    | 'mappings'
    | 'candidates'
    | 'scores'
    | 'clusters'
    | 'review'
    | 'stagedRecords'
  >;
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
const CANDIDATES = {
  busy: 'Candidate pairs are already being found. Wait for that job to finish, or cancel it first.',
  none: 'Standardise at least one source before finding candidate pairs.',
  standardising:
    'A source is being standardised. Wait for that job to finish, then find candidate pairs.',
  outdated: (names: string[]) =>
    `These sources changed after they were standardised: ${names.join(', ')}. ` +
    'Standardise them again first.',
};

const SCORING = {
  busy: 'The candidate pairs are already being scored. Wait for that job to finish, or cancel it first.',
  notRun: 'Find candidate pairs before scoring them.',
  outdated:
    'The candidate pairs are out of date: a source changed after they were found. Find candidate pairs again first.',
  finding: 'Candidate pairs are being found. Wait for that job to finish, then score them.',
};

const PAIR_REVIEW = {
  busy: 'The AI is already reviewing the maybe pairs. Wait for that job to finish, or cancel it first.',
  notRun: 'Score the candidate pairs before asking the AI to review them.',
  outdated:
    'The scores are out of date: the candidate pairs or a source changed after scoring. Score the candidate pairs again first.',
  scoring:
    'The candidate pairs are being scored. Wait for that job to finish, then start the review.',
  none: 'There are no “maybe” pairs to review: every pair was already decided by its score.',
};

const CLUSTERING = {
  busy: 'Clusters are already being built. Wait for that job to finish, or cancel it first.',
  notRun: 'Score the candidate pairs before building clusters.',
  outdated: PAIR_REVIEW.outdated,
  scoring:
    'The candidate pairs are being scored. Wait for that job to finish, then build clusters.',
  reviewing:
    'The AI is reviewing the maybe pairs. Wait for that job to finish, then build clusters.',
};

const EXPORT = {
  outdated:
    'The customers are out of date: the pairs were scored or reviewed again after grouping. Build clusters again first.',
  clustering: 'Clusters are being built. Wait for that job to finish, then export.',
  nothingApproved:
    'No customer is approved yet. Approve customers in Match Review, or export all customers with their review status.',
};

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
   * `candidates` is project-level (payload `{}`): it reads every standardised source, so it
   * needs at least one (409 NO_STANDARDISED_SOURCES), none that changed after its last run
   * (re-profiled: STANDARDISATION_OUTDATED), no standardise job running (STANDARDISE_RUNNING)
   * and no other candidates job (CANDIDATES_RUNNING). The worker checks the sources again.
   */
  async function checkCandidatesJob(project: Project): Promise<void> {
    const sources = await repos.sources.listByProject(project.id);
    const outdated = sources.filter((s) => s.standardisation && s.status !== 'standardised');
    if (outdated.length > 0) {
      throw AppError.conflict(CANDIDATES.outdated(outdated.map((s) => s.name)), {
        reason: 'STANDARDISATION_OUTDATED',
        sourceIds: outdated.map((s) => s.id),
      });
    }
    if (!sources.some((s) => s.status === 'standardised')) {
      throw AppError.conflict(CANDIDATES.none, { reason: 'NO_STANDARDISED_SOURCES' });
    }
    if (await isActive(project, 'standardise')) {
      throw AppError.conflict(CANDIDATES.standardising, { reason: 'STANDARDISE_RUNNING' });
    }
    if (await isActive(project, 'candidates')) {
      throw AppError.conflict(CANDIDATES.busy, { reason: 'CANDIDATES_RUNNING' });
    }
  }

  async function isActive(project: Project, type: JobType): Promise<boolean> {
    const jobs = await Promise.all(
      (await repos.jobs.listActive(project.id, type)).map(withStaleCheck),
    );
    return jobs.some((job) => !isTerminal(job.status));
  }

  /**
   * `scoring` is project-level (payload `{}`): it scores the current candidate pairs, so they
   * must exist (409 CANDIDATES_NOT_RUN) and be current (CANDIDATES_OUTDATED), with no
   * candidates job (CANDIDATES_RUNNING) or other scoring job (SCORING_RUNNING) active. The
   * worker checks the pairs again.
   */
  async function checkScoringJob(project: Project): Promise<void> {
    const candidates = await repos.candidates.findSummary(project.id);
    if (!candidates) {
      throw AppError.conflict(SCORING.notRun, { reason: 'CANDIDATES_NOT_RUN' });
    }
    if (candidatesOutdated(candidates, await repos.sources.listByProject(project.id))) {
      throw AppError.conflict(SCORING.outdated, { reason: 'CANDIDATES_OUTDATED' });
    }
    if (await isActive(project, 'candidates')) {
      throw AppError.conflict(SCORING.finding, { reason: 'CANDIDATES_RUNNING' });
    }
    if (await isActive(project, 'scoring')) {
      throw AppError.conflict(SCORING.busy, { reason: 'SCORING_RUNNING' });
    }
  }

  /**
   * `pair_review` is project-level (payload `{}`): it asks the AI about the maybe pairs of the
   * current scores, so they must exist (409 SCORES_NOT_RUN), be current (SCORES_OUTDATED) and
   * hold at least one maybe pair (NO_MAYBE_PAIRS), with no scoring job (SCORING_RUNNING) or other
   * review (PAIR_REVIEW_RUNNING) active. The worker checks the scores again.
   */
  async function checkPairReviewJob(project: Project): Promise<void> {
    const scores = await repos.scores.findSummary(project.id);
    if (!scores) throw AppError.conflict(PAIR_REVIEW.notRun, { reason: 'SCORES_NOT_RUN' });
    const candidates = await repos.candidates.findSummary(project.id);
    if (
      candidates?.runId !== scores.candidatesRunId ||
      candidatesOutdated(candidates, await repos.sources.listByProject(project.id))
    ) {
      throw AppError.conflict(PAIR_REVIEW.outdated, { reason: 'SCORES_OUTDATED' });
    }
    if (await isActive(project, 'scoring')) {
      throw AppError.conflict(PAIR_REVIEW.scoring, { reason: 'SCORING_RUNNING' });
    }
    const maybe = scores.bandCounts.find((b) => b.band === 'maybe')?.count ?? 0;
    if (maybe === 0) throw AppError.conflict(PAIR_REVIEW.none, { reason: 'NO_MAYBE_PAIRS' });
    if (await isActive(project, 'pair_review')) {
      throw AppError.conflict(PAIR_REVIEW.busy, { reason: 'PAIR_REVIEW_RUNNING' });
    }
  }

  /**
   * `clustering` is project-level (payload `{}`): it groups the records of the current scores,
   * so they must exist (409 SCORES_NOT_RUN) and be current (SCORES_OUTDATED), with no scoring
   * (SCORING_RUNNING), AI review (PAIR_REVIEW_RUNNING: its suggestions would be half written)
   * or other clustering job (CLUSTERING_RUNNING) active. The worker checks again.
   */
  async function checkClusteringJob(project: Project): Promise<void> {
    const scores = await repos.scores.findSummary(project.id);
    if (!scores) throw AppError.conflict(CLUSTERING.notRun, { reason: 'SCORES_NOT_RUN' });
    const candidates = await repos.candidates.findSummary(project.id);
    if (
      candidates?.runId !== scores.candidatesRunId ||
      candidatesOutdated(candidates, await repos.sources.listByProject(project.id))
    ) {
      throw AppError.conflict(CLUSTERING.outdated, { reason: 'SCORES_OUTDATED' });
    }
    if (await isActive(project, 'scoring')) {
      throw AppError.conflict(CLUSTERING.scoring, { reason: 'SCORING_RUNNING' });
    }
    if (await isActive(project, 'pair_review')) {
      throw AppError.conflict(CLUSTERING.reviewing, { reason: 'PAIR_REVIEW_RUNNING' });
    }
    if (await isActive(project, 'clustering')) {
      throw AppError.conflict(CLUSTERING.busy, { reason: 'CLUSTERING_RUNNING' });
    }
  }

  /**
   * `export` is project-level: it writes the golden records of the current clusters, so they
   * must exist (409 CLUSTERS_NOT_RUN) and be current (CLUSTERS_OUTDATED), with no clustering
   * job active (CLUSTERING_RUNNING); the `approved` scope needs at least one customer approved
   * as it is now (NOTHING_APPROVED). The worker checks again and enforces EXPORT_MAX_ROWS.
   */
  async function checkExportJob(project: Project, payload: Record<string, unknown>) {
    const { summary, outdated } = await currentClusters(repos, project);
    if (outdated) throw AppError.conflict(EXPORT.outdated, { reason: 'CLUSTERS_OUTDATED' });
    if (await isActive(project, 'clustering')) {
      throw AppError.conflict(EXPORT.clustering, { reason: 'CLUSTERING_RUNNING' });
    }
    if (payload.scope === 'all') return;
    const approvals = await repos.review.listApprovals(project.id);
    const approved = await repos.clusters.countWithIds(
      project.id,
      summary.runId,
      approvals.map((a) => a.customerId),
    );
    if (approved === 0) {
      throw AppError.conflict(EXPORT.nothingApproved, { reason: 'NOTHING_APPROVED' });
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
      if (type === 'candidates') await checkCandidatesJob(project);
      if (type === 'scoring') await checkScoringJob(project);
      if (type === 'pair_review') await checkPairReviewJob(project);
      if (type === 'clustering') await checkClusteringJob(project);
      if (type === 'export') await checkExportJob(project, payload);
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

    hasActive: isActive,

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
