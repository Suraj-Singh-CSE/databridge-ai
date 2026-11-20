import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';

import { api, refreshSession } from '@/lib/api';
import type { AuthSession } from '@/lib/api-types';
import {
  clearSession,
  getAuthState,
  setSession,
  startAuthSync,
  subscribeToAuth,
} from '@/lib/session';

import {
  AuthContext,
  type AuthContextValue,
  type RegisterInput,
  type SignInInput,
} from './auth-context';

/**
 * Restores the session on load (refresh cookie -> access token), keeps tabs in sync and exposes
 * sign-in, register and sign-out. Cached server data is dropped whenever the user signs out.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const state = useSyncExternalStore(subscribeToAuth, getAuthState);

  useEffect(() => startAuthSync(), []);

  useEffect(() => {
    if (getAuthState().status !== 'unknown') return;
    refreshSession().catch(() => {
      // No valid cookie (or the api is unreachable): start signed out.
      if (getAuthState().status === 'unknown') clearSession({ broadcast: false });
    });
  }, []);

  useEffect(() => {
    if (state.status === 'signed-out') queryClient.clear();
  }, [state.status, queryClient]);

  const signIn = useCallback(async (input: SignInInput) => {
    const session = await api<AuthSession>('/auth/login', { method: 'POST', body: input });
    setSession(session, { broadcast: true });
    return session.user;
  }, []);

  const register = useCallback(async (input: RegisterInput) => {
    const session = await api<AuthSession>('/auth/register', { method: 'POST', body: input });
    setSession(session, { broadcast: true });
    return session.user;
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api<undefined>('/auth/logout', { method: 'POST' });
    } finally {
      // Even if the api is unreachable, forget the session here and in every other tab.
      clearSession({ broadcast: true });
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      state,
      user: state.status === 'signed-in' ? state.user : null,
      signIn,
      register,
      signOut,
    }),
    [state, signIn, register, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
