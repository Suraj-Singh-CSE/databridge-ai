import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { sourceKeys, storeJob } from '@/features/sources/queries';
import { api, ApiError } from '@/lib/api';
import type {
  CandidateSummaryView,
  ClusterDetail,
  ClusterFlag,
  ClusterPage,
  ClusterSummaryView,
  Job,
  ScoreSummaryView,
} from '@/lib/api-types';

const projectPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;

export const CLUSTER_PAGE_SIZE = 20;

export interface ClusterFilters {
  flag?: ClusterFlag;
  minSize?: number;
  cursor?: string;
}

export const matchingKeys = {
  candidates: (projectId: string) => [...sourceKeys.matching(projectId), 'candidates'] as const,
  scores: (projectId: string) => [...sourceKeys.matching(projectId), 'scores'] as const,
  clusterSummary: (projectId: string) =>
    [...sourceKeys.matching(projectId), 'clusters', 'summary'] as const,
  clusters: (projectId: string, filters: ClusterFilters) =>
    [...sourceKeys.matching(projectId), 'clusters', 'list', filters] as const,
  cluster: (projectId: string, customerId: string) =>
    [...sourceKeys.matching(projectId), 'clusters', 'one', customerId] as const,
};

/** The 409 the summaries answer before their job has run once (e.g. `CLUSTERS_NOT_RUN`). */
function isNotRun(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 409) return false;
  const details = error.details;
  if (typeof details !== 'object' || details === null || !('reason' in details)) return false;
  return typeof details.reason === 'string' && details.reason.endsWith('_NOT_RUN');
}

/** GET that answers null while the step has not run yet. */
async function orNotRun<T>(request: Promise<T>): Promise<T | null> {
  try {
    return await request;
  } catch (error) {
    if (isNotRun(error)) return null;
    throw error;
  }
}

export function useCandidateSummary(projectId: string) {
  return useQuery({
    queryKey: matchingKeys.candidates(projectId),
    queryFn: ({ signal }) =>
      orNotRun(
        api<CandidateSummaryView>(`${projectPath(projectId)}/candidates/summary`, { signal }),
      ),
  });
}

export function useScoreSummary(projectId: string) {
  return useQuery({
    queryKey: matchingKeys.scores(projectId),
    queryFn: ({ signal }) =>
      orNotRun(api<ScoreSummaryView>(`${projectPath(projectId)}/scores/summary`, { signal })),
  });
}

export function useClusterSummary(projectId: string) {
  return useQuery({
    queryKey: matchingKeys.clusterSummary(projectId),
    queryFn: ({ signal }) =>
      orNotRun(api<ClusterSummaryView>(`${projectPath(projectId)}/clusters/summary`, { signal })),
  });
}

/** One page of clusters (largest first). Only asked for once clustering has run. */
export function useClusters(projectId: string, filters: ClusterFilters, enabled: boolean) {
  return useQuery({
    queryKey: matchingKeys.clusters(projectId, filters),
    queryFn: ({ signal }) => {
      const query = new URLSearchParams({ limit: String(CLUSTER_PAGE_SIZE) });
      if (filters.flag) query.set('flag', filters.flag);
      if (filters.minSize) query.set('minSize', String(filters.minSize));
      if (filters.cursor) query.set('cursor', filters.cursor);
      return api<ClusterPage>(`${projectPath(projectId)}/clusters?${query.toString()}`, {
        signal,
      });
    },
    enabled,
    placeholderData: keepPreviousData,
  });
}

/** One cluster by customer id (the search box); null asks for nothing. */
export function useCluster(projectId: string, customerId: string | null) {
  return useQuery({
    queryKey: matchingKeys.cluster(projectId, customerId ?? ''),
    queryFn: ({ signal }) =>
      api<ClusterDetail>(
        `${projectPath(projectId)}/clusters/${encodeURIComponent(customerId ?? '')}`,
        { signal },
      ),
    enabled: customerId !== null,
    retry: false,
  });
}

export type MatchingJobType =
  'standardise' | 'candidates' | 'scoring' | 'pair_review' | 'clustering';

export interface StartMatchingJob {
  type: MatchingJobType;
  /** Only for `standardise`, which runs per source. */
  sourceId?: string;
}

export function useStartMatchingJob(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ type, sourceId }: StartMatchingJob) =>
      api<{ job: Job }>(`${projectPath(projectId)}/jobs`, {
        method: 'POST',
        body: { type, payload: sourceId ? { sourceId } : {} },
      }).then((data) => data.job),
    onSuccess: (job) => {
      storeJob(queryClient, job);
    },
    // A 409 may mean the job is already running: fetch it so its progress shows.
    onError: () => queryClient.invalidateQueries({ queryKey: sourceKeys.jobs(projectId) }),
  });
}

/** The newest job of `type` (for `standardise`, of that source); the list is newest first. */
export function latestJob(
  jobs: Job[] | undefined,
  type: MatchingJobType,
  sourceId?: string,
): Job | null {
  return (
    jobs?.find(
      (job) => job.type === type && (sourceId === undefined || job.payload.sourceId === sourceId),
    ) ?? null
  );
}
