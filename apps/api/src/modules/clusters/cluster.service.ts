import { AppError } from '../../errors.js';
import type { Repositories } from '../../repositories.js';
import { candidatesOutdated, type CandidateRecord } from '../candidates/candidate.service.js';
import type { Project } from '../projects/project.types.js';
import type { AiDecision, ScoreBand, ScoreReason } from '../scores/score.types.js';
import type { Source } from '../sources/source.types.js';
import type { StagedRecordRef } from '../staged/staged.types.js';

import type {
  Cluster,
  ClusterApproval,
  ClusterFlag,
  ClusterLink,
  ClusterStatus,
  ClusterSummary,
  GoldenRecord,
} from './cluster.types.js';

/** Whether a person approved the cluster as it is now (ADR 0019). */
export interface ClusterReviewState {
  /** `approved` only while an approval exists for this exact membership (customer id). */
  status: ClusterStatus;
  approval: { approvedBy: string; approvedAt: Date } | null;
  /** Not approved, but some member was in a cluster a person approved: membership changed. */
  membershipChanged: boolean;
}

export interface ClusterView extends Cluster, ClusterReviewState {
  /** The members' standardised fields, in `memberRecordIds` order; null when a record is gone. */
  members: (CandidateRecord | null)[];
  /** The proposed golden record with provenance per field. */
  goldenRecord: GoldenRecord | null;
}

/** Why two members are linked: the scored pair behind the link (null for a person's link). */
export interface LinkEvidence {
  score: number;
  band: ScoreBand;
  reasons: ScoreReason[];
  aiDecision: AiDecision | null;
  aiConfidence: number | null;
  aiReason: string | null;
  suggestedBand: ScoreBand;
}

export interface ClusterDetailView extends ClusterView {
  links: (ClusterLink & { evidence: LinkEvidence | null })[];
}

export interface ReviewCounts {
  /** Clusters of the current run with an approval for their exact membership. */
  approvedCount: number;
  proposedCount: number;
  /** What "Approve all High" would approve now. */
  approvableHighCount: number;
  /** Pair decisions stored (same / different); the run applied `summary.decisionCount`. */
  sameDecisionCount: number;
  differentDecisionCount: number;
}

export interface ClusterSummaryView {
  summary: ClusterSummary;
  /** True when the pairs were scored or reviewed again, or the scores are themselves outdated. */
  outdated: boolean;
  review: ReviewCounts;
}

export interface ClusterPage extends ClusterSummaryView {
  items: ClusterView[];
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
}

export interface ClusterDetail extends ClusterSummaryView {
  cluster: ClusterDetailView;
}

export interface ClusterService {
  summary(project: Project): Promise<ClusterSummaryView>;
  list(
    project: Project,
    query: {
      status?: ClusterStatus | undefined;
      flag?: ClusterFlag | undefined;
      minSize?: number | undefined;
      aiSuggested?: boolean | undefined;
      limit: number;
      cursor?: number | undefined;
    },
  ): Promise<ClusterPage>;
  get(project: Project, customerId: string): Promise<ClusterDetail>;
}

export const CLUSTERS_NOT_RUN =
  'Customers have not been grouped yet. Score the candidate pairs, then run "Build clusters".';
export const CLUSTER_NOT_FOUND = 'No cluster with this customer id in the current proposals.';

/** A staged record's stable key, as the worker builds customer ids (cluster_store.py). */
export function recordKey(
  record: Pick<StagedRecordRef, 'sourceId' | 'sourceRecordId' | 'rowNumber'>,
) {
  const id =
    record.sourceRecordId === null || record.sourceRecordId === '' ? null : record.sourceRecordId;
  return `${record.sourceId}:${id ?? `#${record.rowNumber}`}`;
}

type ReadRepos = Pick<
  Repositories,
  'clusters' | 'review' | 'scores' | 'candidates' | 'sources' | 'stagedRecords'
>;

export interface CurrentClusters {
  summary: ClusterSummary;
  outdated: boolean;
  sources: Source[];
}

/** The project's current clusters run (409 CLUSTERS_NOT_RUN), and whether it is outdated. */
export async function currentClusters(
  repos: ReadRepos,
  project: Project,
): Promise<CurrentClusters> {
  const summary = await repos.clusters.findSummary(project.id);
  if (!summary) throw AppError.conflict(CLUSTERS_NOT_RUN, { reason: 'CLUSTERS_NOT_RUN' });
  const [scores, candidates, sources] = await Promise.all([
    repos.scores.findSummary(project.id),
    repos.candidates.findSummary(project.id),
    repos.sources.listByProject(project.id),
  ]);
  const outdated =
    scores?.runId !== summary.scoresRunId ||
    (scores.aiReview?.jobId ?? null) !== summary.aiReviewJobId ||
    candidates?.runId !== scores.candidatesRunId ||
    candidatesOutdated(candidates, sources);
  return { summary, outdated, sources };
}

function reviewState(
  cluster: Cluster,
  keys: string[],
  approved: Map<string, ClusterApproval>,
  touched: ReadonlySet<string>,
): ClusterReviewState {
  const approval = approved.get(cluster.customerId);
  if (approval) {
    return {
      status: 'approved',
      approval: { approvedBy: approval.approvedBy, approvedAt: approval.approvedAt },
      membershipChanged: false,
    };
  }
  return {
    status: 'proposed',
    approval: null,
    membershipChanged: keys.some((key) => touched.has(key)),
  };
}

export function createClusterService(repos: ReadRepos): ClusterService {
  async function reviewCounts(project: Project, summary: ClusterSummary): Promise<ReviewCounts> {
    const [approvals, decisions] = await Promise.all([
      repos.review.listApprovals(project.id),
      repos.review.countPairDecisions(project.id),
    ]);
    const approvedIds = approvals.map((a) => a.customerId);
    const [approvedCount, approvableHighCount] = await Promise.all([
      repos.clusters.countWithIds(project.id, summary.runId, approvedIds),
      repos.clusters.countApprovable(project.id, summary.runId, approvedIds),
    ]);
    return {
      approvedCount,
      proposedCount: summary.clusterCount - approvedCount,
      approvableHighCount,
      sameDecisionCount: decisions.same,
      differentDecisionCount: decisions.different,
    };
  }

  async function current(project: Project): Promise<ClusterSummaryView & { sources: Source[] }> {
    const found = await currentClusters(repos, project);
    return { ...found, review: await reviewCounts(project, found.summary) };
  }

  async function views(
    project: Project,
    summary: ClusterSummary,
    sources: Source[],
    clusters: Cluster[],
  ): Promise<ClusterView[]> {
    const ids = [...new Set(clusters.flatMap((c) => c.memberRecordIds))];
    const [records, golden] = await Promise.all([
      repos.stagedRecords.findByIds(project.id, ids),
      repos.clusters.findGolden(
        project.id,
        summary.runId,
        clusters.map((c) => c.customerId),
      ),
    ]);
    const byId = new Map(records.map((r) => [r.id, r]));
    const keysOf = (c: Cluster) =>
      c.memberRecordIds.flatMap((id) => {
        const record = byId.get(id);
        return record ? [recordKey(record)] : [];
      });
    const approvals = await repos.review.findApprovalsByKeys(project.id, clusters.flatMap(keysOf));
    const approved = new Map(approvals.map((a) => [a.customerId, a]));
    const touched = new Set(approvals.flatMap((a) => a.memberKeys));
    const goldenById = new Map(golden.map((g) => [g.customerId, g]));
    const names = new Map(sources.map((s) => [s.id, s.name]));
    const member = (id: string): CandidateRecord | null => {
      const record = byId.get(id);
      return record ? { ...record, sourceName: names.get(record.sourceId) ?? '' } : null;
    };
    return clusters.map((c) => {
      const state = reviewState(c, keysOf(c), approved, touched);
      const goldenRecord = goldenById.get(c.customerId);
      return {
        ...c,
        ...state,
        members: c.memberRecordIds.map(member),
        goldenRecord: goldenRecord ? { ...goldenRecord, status: state.status } : null,
      };
    });
  }

  async function withEvidence(
    project: Project,
    summary: ClusterSummary,
    view: ClusterView,
  ): Promise<ClusterDetailView> {
    const scored = await repos.scores.findAmong(
      project.id,
      summary.scoresRunId,
      view.memberRecordIds,
    );
    const pairKey = (a: string, b: string) => (a < b ? `${a}/${b}` : `${b}/${a}`);
    const byPair = new Map(scored.map((s) => [pairKey(s.recordA, s.recordB), s]));
    return {
      ...view,
      links: view.links.map((link) => {
        const pair = byPair.get(pairKey(link.recordA, link.recordB));
        return {
          ...link,
          evidence: pair
            ? {
                score: pair.score,
                band: pair.band,
                reasons: pair.reasons,
                aiDecision: pair.aiDecision,
                aiConfidence: pair.aiConfidence,
                aiReason: pair.aiReason,
                suggestedBand: pair.suggestedBand,
              }
            : null,
        };
      }),
    };
  }

  async function approvalFilter(
    project: Project,
    status: ClusterStatus | undefined,
  ): Promise<{ in: string[] } | { notIn: string[] } | undefined> {
    if (!status) return undefined;
    if (status === 'rejected') return { in: [] };
    const ids = (await repos.review.listApprovals(project.id)).map((a) => a.customerId);
    return status === 'approved' ? { in: ids } : { notIn: ids };
  }

  return {
    async summary(project) {
      const { summary, outdated, review } = await current(project);
      return { summary, outdated, review };
    },

    async list(project, { status, flag, minSize, aiSuggested, limit, cursor }) {
      const { summary, outdated, review, sources } = await current(project);
      // One extra cluster tells whether there is a next page.
      const clusters = await repos.clusters.listClusters(project.id, {
        runId: summary.runId,
        flag,
        minSize,
        aiSuggested,
        customerIds: await approvalFilter(project, status),
        afterPosition: cursor ?? 0,
        limit: limit + 1,
      });
      const page = clusters.slice(0, limit);
      const last = page.at(-1);
      return {
        summary,
        outdated,
        review,
        items: await views(project, summary, sources, page),
        nextCursor: clusters.length > limit && last ? String(last.position) : null,
      };
    },

    async get(project, customerId) {
      const { summary, outdated, review, sources } = await current(project);
      const cluster = await repos.clusters.findCluster(project.id, summary.runId, customerId);
      if (!cluster) throw AppError.notFound(CLUSTER_NOT_FOUND);
      const [view] = await views(project, summary, sources, [cluster]);
      if (!view) throw AppError.notFound(CLUSTER_NOT_FOUND);
      return { summary, outdated, review, cluster: await withEvidence(project, summary, view) };
    },
  };
}
