import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { sourceKeys } from '@/features/sources/queries';
import { api } from '@/lib/api';
import type { Dashboard, DashboardRange } from '@/lib/api-types';

export const dashboardKeys = {
  all: sourceKeys.dashboard,
  range: (projectId: string, range: DashboardRange) =>
    [...dashboardKeys.all(projectId), range] as const,
};

/** GET .../dashboard?range=: counts and timings of the whole project (ADR 0023). */
export function useDashboard(projectId: string, range: DashboardRange) {
  return useQuery({
    queryKey: dashboardKeys.range(projectId, range),
    queryFn: ({ signal }) =>
      api<Dashboard>(
        `/projects/${encodeURIComponent(projectId)}/dashboard?range=${encodeURIComponent(range)}`,
        { signal },
      ),
    // Keep the previous range on screen while the next one loads.
    placeholderData: keepPreviousData,
  });
}
