import { useQuery } from '@tanstack/react-query';

import { sourceKeys } from '@/features/sources/queries';
import { api } from '@/lib/api';
import type { SourceMappings, TargetSchema } from '@/lib/api-types';

const projectPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;

export const mappingKeys = {
  list: (projectId: string, sourceId: string) =>
    [...sourceKeys.all(projectId), sourceId, 'mappings'] as const,
  targetSchema: (projectId: string) => ['projects', projectId, 'target-schema'] as const,
};

/** Suggestions and current decisions for one source; empty columns until mapping has run. */
export function useSourceMappings(projectId: string, sourceId: string | null) {
  return useQuery({
    queryKey: mappingKeys.list(projectId, sourceId ?? ''),
    queryFn: ({ signal }) =>
      api<SourceMappings>(
        `${projectPath(projectId)}/sources/${encodeURIComponent(sourceId ?? '')}/mappings`,
        { signal },
      ),
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
