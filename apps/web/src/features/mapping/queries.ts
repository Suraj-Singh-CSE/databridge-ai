import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { sourceKeys, storeJob } from '@/features/sources/queries';
import { api } from '@/lib/api';
import type {
  AcceptHighResult,
  ColumnMapping,
  Job,
  MappingRole,
  SourceMappings,
  TargetSchema,
} from '@/lib/api-types';

const projectPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;
const mappingsPath = (projectId: string, sourceId: string) =>
  `${projectPath(projectId)}/sources/${encodeURIComponent(sourceId)}/mappings`;

export const mappingKeys = {
  list: (projectId: string, sourceId: string) =>
    [...sourceKeys.all(projectId), sourceId, 'mappings'] as const,
  targetSchema: (projectId: string) => ['projects', projectId, 'target-schema'] as const,
};

/** PATCH body for one column (apps/api mapping.schemas.ts `decideBody`). */
export type MappingDecisionInput =
  | { decision: 'accept' }
  | { decision: 'reject' }
  | { decision: 'override'; role: MappingRole; target: string | null; transform: string | null };

/** Suggestions and current decisions for one source; empty columns until mapping has run. */
export function useSourceMappings(projectId: string, sourceId: string | null) {
  return useQuery({
    queryKey: mappingKeys.list(projectId, sourceId ?? ''),
    queryFn: ({ signal }) =>
      api<SourceMappings>(mappingsPath(projectId, sourceId ?? ''), { signal }),
    enabled: sourceId !== null,
  });
}

export function useTargetSchema(projectId: string) {
  return useQuery({
    queryKey: mappingKeys.targetSchema(projectId),
    queryFn: ({ signal }) =>
      api<{ schema: TargetSchema }>(`${projectPath(projectId)}/target-schema`, { signal }).then(
        (data) => data.schema,
      ),
  });
}

/** Accept, reject or change one column; the list (with its summary) is re-read afterwards. */
export function useDecideMapping(projectId: string, sourceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ column, input }: { column: string; input: MappingDecisionInput }) =>
      api<{ column: ColumnMapping }>(
        `${mappingsPath(projectId, sourceId)}/${encodeURIComponent(column)}`,
        { method: 'PATCH', body: input },
      ).then((data) => data.column),
    onSuccess: (updated) => {
      queryClient.setQueryData<SourceMappings>(mappingKeys.list(projectId, sourceId), (current) =>
        current
          ? {
              ...current,
              columns: current.columns.map((c) => (c.column === updated.column ? updated : c)),
            }
          : current,
      );
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: mappingKeys.list(projectId, sourceId) }),
  });
}

export function useAcceptHigh(projectId: string, sourceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<AcceptHighResult>(`${mappingsPath(projectId, sourceId)}/accept-high`, {
        method: 'POST',
      }),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: mappingKeys.list(projectId, sourceId) }),
  });
}

export function useStartMapping(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sourceId: string) =>
      api<{ job: Job }>(`${projectPath(projectId)}/jobs`, {
        method: 'POST',
        body: { type: 'mapping', payload: { sourceId } },
      }).then((data) => data.job),
    onSuccess: (job) => {
      storeJob(queryClient, job);
    },
    // A 409 may mean a mapping job is already running: fetch it so its progress shows.
    onError: () => queryClient.invalidateQueries({ queryKey: sourceKeys.jobs(projectId) }),
  });
}

/** The newest mapping job for `sourceId`, if any (the job list is newest first). */
export function latestMappingJob(jobs: Job[] | undefined, sourceId: string): Job | null {
  return jobs?.find((job) => job.type === 'mapping' && job.payload.sourceId === sourceId) ?? null;
}
