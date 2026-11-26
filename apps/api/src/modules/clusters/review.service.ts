import { AppError } from '../../errors.js';
import { isDuplicateKeyError } from '../../mongo-errors.js';
import type { Repositories } from '../../repositories.js';
import type { AuditService } from '../audit/audit.service.js';
import type { JobService } from '../jobs/job.service.js';
import type { Job } from '../jobs/job.types.js';
import type { Actor } from '../projects/project.service.js';
import type { Project } from '../projects/project.types.js';
import type { StagedRecordRef } from '../staged/staged.types.js';

import {
  CLUSTER_NOT_FOUND,
  currentClusters,
  recordKey,
  type CurrentClusters,
} from './cluster.service.js';
import type {
  Cluster,
  ClusterApproval,
  DecisionAction,
  PairDecision,
  PairDecisionValue,
} from './cluster.types.js';

/**
 * A person's decisions on proposed clusters (ADR 0019). Pair decisions (`match_decisions`) are
 * the source of truth the clustering job applies; an approval pins one exact membership. Split
 * and merge start a `clustering` job so the proposals reflect the decision.
 */
export interface ApproveResult {
  customerId: string;
  status: 'approved';
  approvedAt: Date;
}

export interface ApproveHighResult {
  approved: number;
  alreadyApproved: number;
}

export interface ReclusterResult {
  decisionsWritten: number;
  /** The clustering job started to apply the decisions; null when it could not start. */
  job: Job | null;
  /** Why the job did not start (the decisions are saved and apply on the next run). */
  jobMessage: string | null;
}

export interface ReviewService {
  approve(actor: Actor, project: Project, customerId: string): Promise<ApproveResult>;
  unapprove(
    actor: Actor,
    project: Project,
    customerId: string,
  ): Promise<{ customerId: string; status: 'proposed' }>;
  approveHigh(actor: Actor, project: Project): Promise<ApproveHighResult>;
  split(
    actor: Actor,
    project: Project,
    customerId: string,
    body: { recordId: string; reason?: string | undefined },
  ): Promise<ReclusterResult>;
  merge(
    actor: Actor,
    project: Project,
    body: { customerIds: [string, string]; reason?: string | undefined },
  ): Promise<ReclusterResult>;
}

export const REVIEW_MESSAGES = {
  outdated:
    'These clusters are out of date: the pairs were scored or reviewed again. A data engineer needs to run "Build clusters" again before you can review them.',
  running:
    'Clusters are being rebuilt right now. Wait for that to finish (a few seconds), then try again.',
  recordsGone:
    'Some records of this cluster no longer exist (a source changed). Build the clusters again first.',
  notMember: 'must be a record of this customer',
  single: 'This customer has only one record: there is nothing to split out.',
  sameCluster: 'must be two different customer ids',
  notApproved: 'This customer is not approved.',
  newerRun:
    'The clusters were rebuilt while you were reviewing. Refresh to see the new clusters, then try again.',
  concurrent: 'Someone else just updated this customer — refresh and try again.',
} as const;

type ReviewRepos = Pick<
  Repositories,
  'clusters' | 'review' | 'scores' | 'candidates' | 'sources' | 'stagedRecords'
>;

export function createReviewService(
  repos: ReviewRepos,
  jobs: Pick<JobService, 'create' | 'hasActive'>,
  audit: AuditService,
  now: () => Date = () => new Date(),
): ReviewService {
  /** Decisions need current clusters and no clustering job active (it would overwrite them). */
  async function ready(project: Project): Promise<CurrentClusters> {
    const found = await currentClusters(repos, project);
    if (found.outdated) {
      throw AppError.conflict(REVIEW_MESSAGES.outdated, { reason: 'CLUSTERS_OUTDATED' });
    }
    if (await jobs.hasActive(project, 'clustering')) {
      throw AppError.conflict(REVIEW_MESSAGES.running, { reason: 'CLUSTERING_RUNNING' });
    }
    return found;
  }

  /**
   * At write time (G3-14): the clusters are still run `runId` and no clustering job started
   * since `ready()`; else 409 CLUSTERS_OUTDATED.
   */
  async function assertSameRun(project: Project, runId: string): Promise<void> {
    const [summary, running] = await Promise.all([
      repos.clusters.findSummary(project.id),
      jobs.hasActive(project, 'clustering'),
    ]);
    if (running || summary?.runId !== runId) {
      throw AppError.conflict(REVIEW_MESSAGES.newerRun, { reason: 'CLUSTERS_OUTDATED' });
    }
  }

  /**
   * Writes approvals and their pinned links for run `runId`, checked against the current run
   * just before and after the write; a write that lost the race to a new run is undone (409).
   * A unique-index clash with a simultaneous write becomes a plain 409 CONFLICT.
   */
  async function writeApprovals(
    project: Project,
    runId: string,
    approvals: ClusterApproval[],
    pinned: PairDecision[],
  ): Promise<void> {
    await assertSameRun(project, runId);
    try {
      await repos.review.savePairDecisions(project.id, pinned);
      await repos.review.saveApprovals(project.id, approvals);
    } catch (error) {
      if (isDuplicateKeyError(error)) throw AppError.conflict(REVIEW_MESSAGES.concurrent);
      throw error;
    }
    try {
      await assertSameRun(project, runId);
    } catch (error) {
      const ids = approvals.map((a) => a.customerId);
      await repos.review.deleteApprovalsOfRun(project.id, ids, runId);
      for (const id of ids) await repos.review.deleteApprovalDecisions(project.id, id);
      throw error;
    }
  }

  async function findCluster(project: Project, runId: string, customerId: string) {
    const cluster = await repos.clusters.findCluster(project.id, runId, customerId);
    if (!cluster) throw AppError.notFound(CLUSTER_NOT_FOUND);
    return cluster;
  }

  /** Every member's staged record, by id (409 when one is gone: the clusters need a re-run). */
  async function membersOf(project: Project, clusters: Cluster[]) {
    const ids = [...new Set(clusters.flatMap((c) => c.memberRecordIds))];
    const records = await repos.stagedRecords.findByIds(project.id, ids);
    if (records.length !== ids.length) {
      throw AppError.conflict(REVIEW_MESSAGES.recordsGone, { reason: 'CLUSTERS_OUTDATED' });
    }
    return new Map(records.map((r) => [r.id, r]));
  }

  function decision(
    actor: Actor,
    runId: string,
    a: StagedRecordRef,
    b: StagedRecordRef,
    value: PairDecisionValue,
    context: { action: DecisionAction; customerId: string; reason: string | null },
  ): PairDecision {
    const [first, second] = recordKey(a) < recordKey(b) ? [a, b] : [b, a];
    return {
      recordA: first.id,
      recordB: second.id,
      keyA: recordKey(first),
      keyB: recordKey(second),
      decision: value,
      ...context,
      decidedBy: actor.user.userId,
      decidedAt: now(),
      runId,
    };
  }

  /** `same` on the cluster's spanning-tree links: enough to hold today's grouping together. */
  function pins(
    actor: Actor,
    runId: string,
    cluster: Cluster,
    records: Map<string, StagedRecordRef>,
  ): PairDecision[] {
    return cluster.links.flatMap((link) => {
      const a = records.get(link.recordA);
      const b = records.get(link.recordB);
      if (!link.tree || !a || !b) return [];
      return [
        decision(actor, runId, a, b, 'same', {
          action: 'approve',
          customerId: cluster.customerId,
          reason: null,
        }),
      ];
    });
  }

  function approvalOf(
    actor: Actor,
    runId: string,
    cluster: Cluster,
    records: Map<string, StagedRecordRef>,
  ): ClusterApproval {
    return {
      customerId: cluster.customerId,
      memberKeys: cluster.memberRecordIds.flatMap((id) => {
        const record = records.get(id);
        return record ? [recordKey(record)] : [];
      }),
      approvedBy: actor.user.userId,
      approvedAt: now(),
      runId,
    };
  }

  function record(
    actor: Actor,
    project: Project,
    action: string,
    entityId: string,
    after: Record<string, unknown>,
  ) {
    return audit.record({
      projectId: project.id,
      actorId: actor.user.userId,
      action,
      entityType: 'cluster',
      entityId,
      after,
      requestId: actor.requestId,
    });
  }

  /** Starts the clustering job; decisions are saved either way, so a refusal is reported. */
  async function recluster(
    actor: Actor,
    project: Project,
  ): Promise<Pick<ReclusterResult, 'job' | 'jobMessage'>> {
    try {
      return {
        job: await jobs.create(actor, project, { type: 'clustering', payload: {} }),
        jobMessage: null,
      };
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      return {
        job: null,
        jobMessage: `Your decision is saved, but the clusters could not be rebuilt yet: ${error.message}`,
      };
    }
  }

  return {
    async approve(actor, project, customerId) {
      const { summary } = await ready(project);
      const cluster = await findCluster(project, summary.runId, customerId);
      const records = await membersOf(project, [cluster]);
      const approval = approvalOf(actor, summary.runId, cluster, records);
      const pinned = pins(actor, summary.runId, cluster, records);
      await writeApprovals(project, summary.runId, [approval], pinned);
      await record(actor, project, 'cluster.approve', customerId, {
        size: cluster.size,
        label: cluster.label,
        pinnedLinks: pinned.length,
        runId: summary.runId,
      });
      return { customerId, status: 'approved', approvedAt: approval.approvedAt };
    },

    async unapprove(actor, project, customerId) {
      await ready(project);
      const removed = await repos.review.deleteApproval(project.id, customerId);
      if (!removed) throw AppError.notFound(REVIEW_MESSAGES.notApproved);
      await repos.review.deleteApprovalDecisions(project.id, customerId);
      await record(actor, project, 'cluster.unapprove', customerId, {
        approvedAt: removed.approvedAt.toISOString(),
      });
      return { customerId, status: 'proposed' };
    },

    async approveHigh(actor, project) {
      const { summary } = await ready(project);
      const [candidates, approvals] = await Promise.all([
        repos.clusters.listApprovable(project.id, summary.runId),
        repos.review.listApprovals(project.id),
      ]);
      const approvedIds = new Set(approvals.map((a) => a.customerId));
      const todo = candidates.filter((c) => !approvedIds.has(c.customerId));
      const records =
        todo.length > 0 ? await membersOf(project, todo) : new Map<string, StagedRecordRef>();
      await writeApprovals(
        project,
        summary.runId,
        todo.map((c) => approvalOf(actor, summary.runId, c, records)),
        todo.flatMap((c) => pins(actor, summary.runId, c, records)),
      );
      const result = { approved: todo.length, alreadyApproved: candidates.length - todo.length };
      await record(actor, project, 'cluster.approve_high', project.id, {
        ...result,
        runId: summary.runId,
      });
      return result;
    },

    async split(actor, project, customerId, { recordId, reason }) {
      const { summary } = await ready(project);
      const cluster = await findCluster(project, summary.runId, customerId);
      if (!cluster.memberRecordIds.includes(recordId)) {
        throw AppError.validation('Some fields are invalid.', [
          { field: 'body.recordId', message: REVIEW_MESSAGES.notMember },
        ]);
      }
      if (cluster.size < 2) {
        throw AppError.conflict(REVIEW_MESSAGES.single, { reason: 'NOTHING_TO_SPLIT' });
      }
      const records = await membersOf(project, [cluster]);
      const out = records.get(recordId);
      if (!out)
        throw AppError.conflict(REVIEW_MESSAGES.recordsGone, { reason: 'CLUSTERS_OUTDATED' });
      const context = { action: 'split' as const, customerId, reason: reason ?? null };
      const decisions = cluster.memberRecordIds.flatMap((id) => {
        const other = records.get(id);
        return other && id !== recordId
          ? [decision(actor, summary.runId, out, other, 'different', context)]
          : [];
      });
      await assertSameRun(project, summary.runId);
      await repos.review.savePairDecisions(project.id, decisions);
      const started = await recluster(actor, project);
      await record(actor, project, 'cluster.split', customerId, {
        recordId,
        decisions: decisions.length,
        reason: reason ?? null,
        jobId: started.job?.id ?? null,
        runId: summary.runId,
      });
      return { decisionsWritten: decisions.length, ...started };
    },

    async merge(actor, project, { customerIds, reason }) {
      const { summary } = await ready(project);
      const [first, second] = await Promise.all(
        customerIds.map((id) => findCluster(project, summary.runId, id)),
      );
      if (!first || !second) throw AppError.notFound(CLUSTER_NOT_FOUND);
      const records = await membersOf(project, [first, second]);
      // The strongest scored pair across the two clusters, else their first members.
      const inFirst = new Set(first.memberRecordIds);
      const inSecond = new Set(second.memberRecordIds);
      const scored = await repos.scores.findAmong(project.id, summary.scoresRunId, [
        ...first.memberRecordIds,
        ...second.memberRecordIds,
      ]);
      const across = scored
        .filter(
          (s) =>
            (inFirst.has(s.recordA) && inSecond.has(s.recordB)) ||
            (inSecond.has(s.recordA) && inFirst.has(s.recordB)),
        )
        .sort((a, b) => b.score - a.score)[0];
      const [idA, idB] = across
        ? [across.recordA, across.recordB]
        : [first.memberRecordIds[0], second.memberRecordIds[0]];
      const a = idA ? records.get(idA) : undefined;
      const b = idB ? records.get(idB) : undefined;
      if (!a || !b)
        throw AppError.conflict(REVIEW_MESSAGES.recordsGone, { reason: 'CLUSTERS_OUTDATED' });
      const merged = decision(actor, summary.runId, a, b, 'same', {
        action: 'merge',
        customerId: first.customerId,
        reason: reason ?? null,
      });
      await assertSameRun(project, summary.runId);
      await repos.review.savePairDecisions(project.id, [merged]);
      const started = await recluster(actor, project);
      await record(actor, project, 'cluster.merge', first.customerId, {
        customerIds,
        sizes: [first.size, second.size],
        scoredLink: across !== undefined,
        reason: reason ?? null,
        jobId: started.job?.id ?? null,
        runId: summary.runId,
      });
      return { decisionsWritten: 1, ...started };
    },
  };
}
