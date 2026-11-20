import { QueryClient } from '@tanstack/react-query';

import { ApiError } from '@/lib/api';

/** Retries network/5xx failures twice; 4xx answers (e.g. 404, 403) are final. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
          return failureCount < 2;
        },
      },
      mutations: { retry: false },
    },
  });
}
