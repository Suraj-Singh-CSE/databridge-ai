import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { sourceKeys, storeJob } from '@/features/sources/queries';
import { api, ApiError } from '@/lib/api';
import type {
  ApproveHighResult,
  CandidateSummaryView,
  ClusterDetail,
  ClusterFlag,
  ClusterPage,
  ClusterSummaryView,
  Job,
  ReclusterResult,
  ScoreSummaryView,
} from '@/lib/api-types';

const projectPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;

export const CLUSTER_PAGE_SIZE = 20;

export interface ClusterFilters {
  flag?: ClusterFlag;
  minSize?: number;
  aiSuggested?: boolean;
  status?: 'approved' | 'proposed';
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
      if (filters.aiSuggested !== undefined) query.set('aiSuggested', String(filters.aiSuggested));
      if (filters.status) query.set('status', filters.status);
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

/* ---------- Review decisions (approve, split, merge; ADR 0019) ---------- */

const clustersPath = (projectId: string) => `${projectPath(projectId)}/clusters`;
const customerPath = (projectId: string, customerId: string) =>
  `${clustersPath(projectId)}/${encodeURIComponent(customerId)}`;

/** After a decision every clusters view is re-read; a started clustering job is followed live. */
function useReviewMutation<Input, Result>(
  projectId: string,
  request: (input: Input) => Promise<Result>,
  jobOf: (result: Result) => Job | null = () => null,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: (result) => {
      const job = jobOf(result);
      if (job) storeJob(queryClient, job);
      return queryClient.invalidateQueries({ queryKey: sourceKeys.matching(projectId) });
    },
  });
}

const startedJob = (result: ReclusterResult) => result.job;

export function useApproveCluster(projectId: string) {
  return useReviewMutation(projectId, (customerId: string) =>
    api<{ customerId: string; status: 'approved' }>(
      `${customerPath(projectId, customerId)}/approve`,
      { method: 'POST', body: {} },
    ),
  );
}

export function useUndoApproval(projectId: string) {
  return useReviewMutation(projectId, (customerId: string) =>
    api<{ customerId: string; status: 'proposed' }>(
      `${customerPath(projectId, customerId)}/approval`,
      { method: 'DELETE' },
    ),
  );
}

export function useApproveHigh(projectId: string) {
  return useReviewMutation(projectId, () =>
    api<ApproveHighResult>(`${clustersPath(projectId)}/approve-high`, {
      method: 'POST',
      body: {},
    }),
  );
}

export interface SplitInput {
  customerId: string;
  recordId: string;
  reason?: string;
}

export function useSplitRecord(projectId: string) {
  return useReviewMutation(
    projectId,
    ({ customerId, recordId, reason }: SplitInput) =>
      api<ReclusterResult>(`${customerPath(projectId, customerId)}/split`, {
        method: 'POST',
        body: reason ? { recordId, reason } : { recordId },
      }),
    startedJob,
  );
}

export interface MergeInput {
  customerIds: [string, string];
  reason?: string;
}

export function useMergeClusters(projectId: string) {
  return useReviewMutation(
    projectId,
    ({ customerIds, reason }: MergeInput) =>
      api<ReclusterResult>(`${clustersPath(projectId)}/merge`, {
        method: 'POST',
        body: reason ? { customerIds, reason } : { customerIds },
      }),
    startedJob,
  );
}

/** Plain-language text for a failed review decision. */
export function reviewErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Please try again.';
  if (error.status === 0) {
    return 'We could not reach the server. Check your connection and try again.';
  }
  if (error.status === 403) {
    return 'You do not have permission to review customers in this project.';
  }
  if (error.status === 404) {
    return 'This customer no longer exists in the current groups. Refresh the list.';
  }
  return error.message;
}
