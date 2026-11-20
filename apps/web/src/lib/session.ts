/**
 * The browser's view of the signed-in session, kept in memory only (never localStorage):
 * the access token, the current user, and a sync channel so every tab of the app agrees.
 *
 * Cross-tab protocol on BroadcastChannel('databridge-auth'), see ADR 0007:
 * - `session`: a tab got a new access token (sign-in, register or refresh). Other tabs adopt it,
 *   so they do not need to spend the rotating refresh cookie themselves.
 * - `signed-out`: a tab signed out. Other tabs drop their token and show the sign-in page.
 */
import type { AuthSession, User } from '@/lib/api-types';

export type AuthState =
  { status: 'unknown' } | { status: 'signed-in'; user: User } | { status: 'signed-out' };

export type AuthMessage =
  { type: 'session'; at: number; session: AuthSession } | { type: 'signed-out'; at: number };

const CHANNEL_NAME = 'databridge-auth';

let accessToken: string | null = null;
let state: AuthState = { status: 'unknown' };
/** When this tab last adopted a session sent by another tab (Date.now()), 0 if never. */
let lastSessionFromOtherTabAt = 0;
let channel: BroadcastChannel | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function post(message: AuthMessage): void {
  channel?.postMessage(message);
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function getAuthState(): AuthState {
  return state;
}

export function subscribeToAuth(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stores a new session. `broadcast` shares it with other tabs (they adopt the token). */
export function setSession(session: AuthSession, { broadcast }: { broadcast: boolean }): void {
  accessToken = session.accessToken;
  state = { status: 'signed-in', user: session.user };
  if (broadcast) post({ type: 'session', at: Date.now(), session });
  emit();
}

/** Forgets the session. `broadcast` signs out every other tab as well (explicit sign-out). */
export function clearSession({ broadcast }: { broadcast: boolean }): void {
  accessToken = null;
  state = { status: 'signed-out' };
  if (broadcast) post({ type: 'signed-out', at: Date.now() });
  emit();
}

/**
 * The session another tab sent after `since` (Date.now() value), if any. Used after waiting for
 * the refresh lock: if another tab refreshed meanwhile, reuse its token instead of refreshing again.
 */
export function sessionFromOtherTabSince(since: number): AuthSession | null {
  if (lastSessionFromOtherTabAt < since || !accessToken || state.status !== 'signed-in') {
    return null;
  }
  return { user: state.user, accessToken };
}

/** Applies a message from another tab. Exported for tests; the channel calls it in the app. */
export function receiveAuthMessage(message: AuthMessage): void {
  if (message.type === 'session') {
    lastSessionFromOtherTabAt = Date.now();
    setSession(message.session, { broadcast: false });
  } else {
    clearSession({ broadcast: false });
  }
}

/** Starts listening to other tabs. Returns a function that stops listening. */
export function startAuthSync(): () => void {
  if (channel || typeof BroadcastChannel === 'undefined') return () => undefined;
  const opened = new BroadcastChannel(CHANNEL_NAME);
  opened.onmessage = (event: MessageEvent<AuthMessage>) => {
    receiveAuthMessage(event.data);
  };
  channel = opened;
  return () => {
    opened.close();
    if (channel === opened) channel = null;
  };
}

/** Test helper: back to a fresh page load. */
export function resetSessionForTests(): void {
  accessToken = null;
  state = { status: 'unknown' };
  lastSessionFromOtherTabAt = 0;
  listeners.clear();
}
