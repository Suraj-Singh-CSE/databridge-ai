import { render } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';

import { AppProviders } from '@/app/AppProviders';
import { createQueryClient } from '@/app/query-client';
import { routes } from '@/app/routes';

/** Renders the whole app (providers + routes) at `path` with an in-memory router. */
export function renderApp(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: 0 } });
  const view = render(<AppProviders router={router} queryClient={queryClient} />);
  return { ...view, router, queryClient };
}
