import { AppError } from '../../errors.js';
import type { Repositories } from '../../repositories.js';
import { candidatesOutdated, type CandidateRecord } from '../candidates/candidate.service.js';
import type { Project } from '../projects/project.types.js';
import type { Source } from '../sources/source.types.js';

import type {
  Cluster,
  ClusterFlag,
  ClusterStatus,
  ClusterSummary,
  GoldenRecord,
} from './cluster.types.js';

export interface ClusterView extends Cluster {
  /** The members' standardised fields, in `memberRecordIds` order; null when a record is gone. */
  members: (CandidateRecord | null)[];
  /** The proposed golden record with provenance per field. */
  goldenRecord: GoldenRecord | null;
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

export interface ClusterService {
  summary(project: Project): Promise<ClusterSummaryView>;
  list(
    project: Project,
    query: {
      status?: ClusterStatus | undefined;
      flag?: ClusterFlag | undefined;
      minSize?: number | undefined;
      limit: number;
      cursor?: number | undefined;
    },
  ): Promise<ClusterPage>;
  get(project: Project, customerId: string): Promise<ClusterDetail>;
}

export const CLUSTERS_NOT_RUN =
  'Customers have not been grouped yet. Score the candidate pairs, then run "Build clusters".';
export const CLUSTER_NOT_FOUND = 'No cluster with this customer id in the current proposals.';

export function createClusterService(
  repos: Pick<Repositories, 'clusters' | 'scores' | 'candidates' | 'sources' | 'stagedRecords'>,
): ClusterService {
  async function current(project: Project): Promise<ClusterSummaryView & { sources: Source[] }> {
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
    const goldenById = new Map(golden.map((g) => [g.customerId, g]));
    const names = new Map(sources.map((s) => [s.id, s.name]));
    const member = (id: string): CandidateRecord | null => {
      const record = byId.get(id);
      return record ? { ...record, sourceName: names.get(record.sourceId) ?? '' } : null;
    };
    return clusters.map((c) => ({
      ...c,
      members: c.memberRecordIds.map(member),
      goldenRecord: goldenById.get(c.customerId) ?? null,
    }));
  }

  return {
    async summary(project) {
      const { summary, outdated } = await current(project);
      return { summary, outdated };
    },

    async list(project, { status, flag, minSize, limit, cursor }) {
      const { summary, outdated, sources } = await current(project);
      // One extra cluster tells whether there is a next page.
      const clusters = await repos.clusters.listClusters(project.id, {
        runId: summary.runId,
        status,
        flag,
        minSize,
        afterPosition: cursor ?? 0,
        limit: limit + 1,
      });
      const page = clusters.slice(0, limit);
      const last = page.at(-1);
      return {
        summary,
        outdated,
        items: await views(project, summary, sources, page),
        nextCursor: clusters.length > limit && last ? String(last.position) : null,
      };
    },

    async get(project, customerId) {
      const { summary, outdated, sources } = await current(project);
      const cluster = await repos.clusters.findCluster(project.id, summary.runId, customerId);
      if (!cluster) throw AppError.notFound(CLUSTER_NOT_FOUND);
      const [view] = await views(project, summary, sources, [cluster]);
      if (!view) throw AppError.notFound(CLUSTER_NOT_FOUND);
      return { summary, outdated, cluster: view };
    },
  };
}
