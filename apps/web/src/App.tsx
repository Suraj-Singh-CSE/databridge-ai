import { createBrowserRouter } from 'react-router';

import { AppProviders } from '@/app/AppProviders';
import { createQueryClient } from '@/app/query-client';
import { routes } from '@/app/routes';

const router = createBrowserRouter(routes);
const queryClient = createQueryClient();

export default function App() {
  return <AppProviders router={router} queryClient={queryClient} />;
}
