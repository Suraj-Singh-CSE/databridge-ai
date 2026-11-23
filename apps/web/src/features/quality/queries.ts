import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api';
import type {
  Page,
  QualityRuleOverride,
  QualityRulesView,
  QualityRun,
  QualityRunSummary,
} from '@/lib/api-types';

const qualityPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/quality`;

export const HISTORY_SIZE = 20;

export const qualityKeys = {
  all: (projectId: string) => ['projects', projectId, 'quality'] as const,
  latest: (projectId: string) => [...qualityKeys.all(projectId), 'latest'] as const,
  runs: (projectId: string) => [...qualityKeys.all(projectId), 'runs'] as const,
  rules: (projectId: string) => [...qualityKeys.all(projectId), 'rules'] as const,
};

/** The newest report, or null before the first quality check. */
export function useLatestQuality(projectId: string) {
  return useQuery({
    queryKey: qualityKeys.latest(projectId),
    queryFn: ({ signal }) =>
      api<{ run: QualityRun | null }>(`${qualityPath(projectId)}/latest`, { signal }).then(
        (data) => data.run,
      ),
  });
}

/** The newest reports (summaries without results), newest first. */
export function useQualityHistory(projectId: string) {
  return useQuery({
    queryKey: qualityKeys.runs(projectId),
    queryFn: ({ signal }) =>
      api<Page<QualityRunSummary>>(`${qualityPath(projectId)}/runs?limit=${HISTORY_SIZE}`, {
        signal,
      }),
  });
}

export function useQualityRules(projectId: string) {
  return useQuery({
    queryKey: qualityKeys.rules(projectId),
    queryFn: ({ signal }) =>
      api<{ rules: QualityRulesView }>(`${qualityPath(projectId)}/rules`, { signal }).then(
        (data) => data.rules,
      ),
  });
}

/** PUT .../quality/rules: replaces the project's overrides (apps/api quality.schemas.ts). */
export interface QualityRulesInput {
  rules: Record<string, QualityRuleOverride>;
  fields: QualityRulesView['fields'];
}

export function useSaveQualityRules(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: QualityRulesInput) =>
      api<{ rules: QualityRulesView }>(`${qualityPath(projectId)}/rules`, {
        method: 'PUT',
        body: input,
      }).then((data) => data.rules),
    onSuccess: (rules) => {
      queryClient.setQueryData(qualityKeys.rules(projectId), rules);
    },
  });
}
