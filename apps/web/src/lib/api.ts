/**
 * Typed client for apps/api. Every call goes to /api/v1, sends the refresh cookie
 * (`credentials: 'include'`) and the in-memory access token, unwraps the `{ data, error }`
 * envelope and throws ApiError on failure.
 *
 * Expired access token: a 401 on a non-auth route triggers one refresh and one retry.
 * Refreshes are single-flight within a tab (one shared promise) and serialised across tabs with
 * the Web Locks API, so two tabs never present the same refresh cookie (which the api would treat
 * as token theft and revoke the session). See docs/adr/0007-frontend-architecture-and-sessions.md.
 */
import type { ApiErrorCode, AuthSession } from '@/lib/api-types';
import { clearSession, getAccessToken, sessionFromOtherTabSince, setSession } from '@/lib/session';

export const API_BASE = '/api/v1';
export const REFRESH_LOCK = 'databridge-refresh';

export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details: unknown = null,
  ) {
    super(message);
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

const GENERIC_MESSAGE = 'Something went wrong. Please try again.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Auth routes answer 401 for wrong credentials or a dead cookie; refreshing would not help. */
function isAuthRoute(path: string): boolean {
  return path.startsWith('/auth/');
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const headers = new Headers({ Accept: 'application/json' });
  const token = getAccessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');

  const init: RequestInit = {
    method: options.method ?? 'GET',
    headers,
    credentials: 'include',
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  if (options.signal) init.signal = options.signal;

  try {
    return await fetch(new URL(API_BASE + path, window.location.origin), init);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      'Could not reach the server. Check your connection and try again.',
    );
  }
}

/** Reads the envelope: returns `data` or throws ApiError. A 204 resolves to undefined. */
async function unwrap<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Not JSON (e.g. a proxy error page): handled as a generic error below.
  }

  const error = isRecord(body) ? body.error : null;
  if (!response.ok || isRecord(error)) {
    if (isRecord(error) && typeof error.code === 'string' && typeof error.message === 'string') {
      throw new ApiError(
        response.status,
        error.code as ApiErrorCode,
        error.message,
        error.details ?? null,
      );
    }
    throw new ApiError(response.status, 'INTERNAL_ERROR', GENERIC_MESSAGE);
  }
  if (!isRecord(body) || !('data' in body)) {
    throw new ApiError(response.status, 'INTERNAL_ERROR', GENERIC_MESSAGE);
  }
  return body.data as T;
}

async function withRefreshLock<T>(task: () => Promise<T>): Promise<T> {
  if (typeof navigator === 'undefined' || !('locks' in navigator)) return task();
  return navigator.locks.request(REFRESH_LOCK, task);
}

async function refreshUnderLock(requestedAt: number): Promise<AuthSession> {
  // Another tab may have refreshed while we waited for the lock and shared its token.
  const shared = sessionFromOtherTabSince(requestedAt);
  if (shared) return shared;

  const response = await send('/auth/refresh', { method: 'POST' });
  try {
    const session = await unwrap<AuthSession>(response);
    setSession(session, { broadcast: true });
    return session;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) clearSession({ broadcast: false });
    throw error;
  }
}

let refreshInFlight: Promise<AuthSession> | null = null;

/**
 * Exchanges the refresh cookie for a new access token. Concurrent callers in this tab share one
 * request; other tabs wait for the same Web Lock. Rejects with ApiError (401: signed out).
 */
export function refreshSession(): Promise<AuthSession> {
  if (!refreshInFlight) {
    const requestedAt = Date.now();
    refreshInFlight = withRefreshLock(() => refreshUnderLock(requestedAt)).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/** Calls the api and returns the envelope's `data`. */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const tokenUsed = getAccessToken();
  const response = await send(path, options);
  if (response.status !== 401 || isAuthRoute(path)) return unwrap<T>(response);

  // The token may already have been replaced (another request or tab refreshed meanwhile).
  const current = getAccessToken();
  if (!current || current === tokenUsed) {
    try {
      await refreshSession();
    } catch {
      return unwrap<T>(response); // throws the original 401
    }
  }
  return unwrap<T>(await send(path, options));
}

/** Validation details as `{ fieldName: message }`, e.g. "body.email" becomes "email". */
export function fieldErrorsOf(error: ApiError): Record<string, string> {
  if (error.code !== 'VALIDATION_ERROR' || !Array.isArray(error.details)) return {};
  const result: Record<string, string> = {};
  for (const issue of error.details as unknown[]) {
    if (!isRecord(issue) || typeof issue.field !== 'string' || typeof issue.message !== 'string') {
      continue;
    }
    const field = issue.field.replace(/^body\./, '');
    result[field] ??= issue.message;
  }
  return result;
}
