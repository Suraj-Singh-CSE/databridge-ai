import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';

import { api } from '@/lib/api';
import type { Job, Source, SourcePreview, SourceProfile } from '@/lib/api-types';
import { isTerminalStatus } from '@/lib/job-events';

/** Recent jobs are enough to find the running ones (the api lists newest first, max 100). */
const JOB_LIST_LIMIT = 50;
const PREVIEW_ROWS = 20;

const projectPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;
const sourcePath = (projectId: string, sourceId: string) =>
  `${projectPath(projectId)}/sources/${encodeURIComponent(sourceId)}`;

export const sourceKeys = {
  all: (projectId: string) => ['projects', projectId, 'sources'] as const,
  list: (projectId: string) => [...sourceKeys.all(projectId), 'list'] as const,
  preview: (projectId: string, sourceId: string) =>
    [...sourceKeys.all(projectId), sourceId, 'preview'] as const,
  profile: (projectId: string, sourceId: string) =>
    [...sourceKeys.all(projectId), sourceId, 'profile'] as const,
  jobs: (projectId: string) => ['projects', projectId, 'jobs'] as const,
  /** Root of the matching results' keys (features/matching/queries.ts). */
  matching: (projectId: string) => ['projects', projectId, 'matching'] as const,
  /** Roots of the SQL / exports and data quality keys (features/pipeline, features/quality). */
  pipeline: (projectId: string) => ['projects', projectId, 'pipeline'] as const,
  quality: (projectId: string) => ['projects', projectId, 'quality'] as const,
};

export function useSources(projectId: string) {
  return useQuery({
    queryKey: sourceKeys.list(projectId),
    queryFn: ({ signal }) =>
      api<{ items: Source[] }>(`${projectPath(projectId)}/sources`, { signal }).then(
        (data) => data.items,
      ),
  });
}

export function useSourcePreview(projectId: string, sourceId: string | null) {
  return useQuery({
    queryKey: sourceKeys.preview(projectId, sourceId ?? ''),
    queryFn: ({ signal }) =>
      api<SourcePreview>(`${sourcePath(projectId, sourceId ?? '')}/preview?limit=${PREVIEW_ROWS}`, {
        signal,
      }),
    enabled: sourceId !== null,
  });
}

export function useSourceProfile(projectId: string, sourceId: string | null) {
  return useQuery({
    queryKey: sourceKeys.profile(projectId, sourceId ?? ''),
    queryFn: ({ signal }) =>
      api<SourceProfile>(`${sourcePath(projectId, sourceId ?? '')}/profile`, { signal }),
    enabled: sourceId !== null,
  });
}

/** The project's recent jobs (newest first); the live watchers keep their entries current. */
export function useProjectJobs(projectId: string) {
  return useQuery({
    queryKey: sourceKeys.jobs(projectId),
    queryFn: ({ signal }) =>
      api<{ items: Job[] }>(`${projectPath(projectId)}/jobs?limit=${JOB_LIST_LIMIT}`, {
        signal,
      }).then((data) => data.items),
  });
}

/** Queued or running profile job per source id. */
export function activeProfileJobs(jobs: Job[] | undefined): Map<string, Job> {
  const active = new Map<string, Job>();
  for (const job of jobs ?? []) {
    const sourceId = job.payload.sourceId;
    if (job.type !== 'profile' || typeof sourceId !== 'string') continue;
    if (!isTerminalStatus(job.status) && !active.has(sourceId)) active.set(sourceId, job);
  }
  return active;
}

/** Puts `job` (new or changed) into the cached job list. */
export function storeJob(queryClient: QueryClient, job: Job): void {
  queryClient.setQueryData<Job[]>(sourceKeys.jobs(job.projectId), (jobs = []) =>
    jobs.some((item) => item.id === job.id)
      ? jobs.map((item) => (item.id === job.id ? job : item))
      : [job, ...jobs],
  );
}

const startProfileKey = (projectId: string) => ['start-profile', projectId] as const;
const cancelJobKey = ['cancel-job'] as const;

export function useStartProfile(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: startProfileKey(projectId),
    mutationFn: (sourceId: string) =>
      api<{ job: Job }>(`${projectPath(projectId)}/jobs`, {
        method: 'POST',
        body: { type: 'profile', payload: { sourceId } },
      }).then((data) => data.job),
    onSuccess: (job) => {
      storeJob(queryClient, job);
    },
    // A 409 means a job is already running for the source: fetch it so its progress shows.
    onError: () => queryClient.invalidateQueries({ queryKey: sourceKeys.jobs(projectId) }),
  });
}

export function useCancelJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: cancelJobKey,
    mutationFn: (jobId: string) =>
      api<{ job: Job }>(`/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }).then(
        (data) => data.job,
      ),
    onSuccess: (job) => {
      storeJob(queryClient, job);
    },
  });
}

/** Source ids with a profile request in flight, and job ids with a cancel in flight. */
export function usePendingJobActions(projectId: string) {
  const starting = useMutationState({
    filters: { mutationKey: startProfileKey(projectId), status: 'pending' },
    select: (mutation) => mutation.state.variables as string,
  });
  const cancelling = useMutationState({
    filters: { mutationKey: cancelJobKey, status: 'pending' },
    select: (mutation) => mutation.state.variables as string,
  });
  return { starting: new Set(starting), cancelling: new Set(cancelling) };
}

export function useDeleteSource(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sourceId: string) =>
      api<undefined>(sourcePath(projectId, sourceId), { method: 'DELETE' }),
    onSuccess: async (_data, sourceId) => {
      queryClient.setQueryData<Source[]>(sourceKeys.list(projectId), (sources) =>
        sources?.filter((source) => source.id !== sourceId),
      );
      queryClient.removeQueries({ queryKey: [...sourceKeys.all(projectId), sourceId] });
      await queryClient.invalidateQueries({ queryKey: sourceKeys.list(projectId) });
    },
  });
}

/**
 * After a job ends: the source's status, counts and profile have changed, and so may the
 * matching results (candidates, scores, clusters), the SQL versions and exports, and the
 * quality reports that the later jobs write.
 */
export async function refreshAfterJob(queryClient: QueryClient, projectId: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: sourceKeys.all(projectId) }),
    queryClient.invalidateQueries({ queryKey: sourceKeys.jobs(projectId) }),
    queryClient.invalidateQueries({ queryKey: sourceKeys.matching(projectId) }),
    queryClient.invalidateQueries({ queryKey: sourceKeys.pipeline(projectId) }),
    queryClient.invalidateQueries({ queryKey: sourceKeys.quality(projectId) }),
  ]);
}
