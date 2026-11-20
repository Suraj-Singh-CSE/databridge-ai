import { Navigate, Outlet, useLocation, useSearchParams } from 'react-router';

import { FullPageStatus } from '@/components/FullPageStatus';

import { useAuth } from './auth-context';
import { safeNextPath } from './next-path';

/** Renders child routes for signed-in users; sends everyone else to /sign-in?next=<here>. */
export function RequireAuth() {
  const { state } = useAuth();
  const location = useLocation();

  if (state.status === 'unknown') return <FullPageStatus label="Loading your session" />;
  if (state.status === 'signed-out') {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/sign-in?next=${next}`} replace />;
  }
  return <Outlet />;
}

/** Sign-in and create-account pages: signed-in users go on to `next` (default /projects). */
export function GuestOnly() {
  const { state } = useAuth();
  const [params] = useSearchParams();

  if (state.status === 'unknown') return <FullPageStatus label="Loading your session" />;
  if (state.status === 'signed-in')
    return <Navigate to={safeNextPath(params.get('next'))} replace />;
  return <Outlet />;
}
