import { createContext, useContext } from 'react';

import type { User } from '@/lib/api-types';
import type { AuthState } from '@/lib/session';

export interface SignInInput {
  email: string;
  password: string;
}

export interface RegisterInput extends SignInInput {
  name: string;
}

export interface AuthContextValue {
  state: AuthState;
  /** The signed-in user, or null while unknown or signed out. */
  user: User | null;
  signIn: (input: SignInInput) => Promise<User>;
  register: (input: RegisterInput) => Promise<User>;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}
