import { useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';
import type { AuthConfig } from '@/lib/api-types';

/** Public sign-up settings, so Create account can ask for an invite code or say it is closed. */
export function useAuthConfig() {
  return useQuery({
    queryKey: ['auth', 'config'],
    queryFn: ({ signal }) => api<AuthConfig>('/auth/config', { signal }),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}
