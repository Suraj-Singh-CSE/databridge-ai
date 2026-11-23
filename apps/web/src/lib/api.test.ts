import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  api,
  ApiError,
  fieldErrorsOf,
  filenameFromDisposition,
  REFRESH_LOCK,
  refreshSession,
} from '@/lib/api';
import { getAccessToken, getAuthState, receiveAuthMessage, setSession } from '@/lib/session';
import { API, fail, makeSession, ok } from '@/test/fixtures';
import { server } from '@/test/server';

/** A protected endpoint that accepts only `validToken` and counts its calls. */
function protectedEndpoint(validToken: string) {
  const calls: (string | null)[] = [];
  server.use(
    http.get(`${API}/projects`, ({ request }) => {
      const auth = request.headers.get('Authorization');
      calls.push(auth);
      return auth === `Bearer ${validToken}`
        ? ok({ items: [], page: 1, limit: 20, total: 0 })
        : fail(401, 'UNAUTHORIZED', 'Authentication required.');
    }),
  );
  return calls;
}

/** A refresh endpoint that hands out `token` and counts its calls. */
function refreshEndpoint(token: string) {
  let calls = 0;
  server.use(
    http.post(`${API}/auth/refresh`, async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return ok(makeSession('data_engineer', token));
    }),
  );
  return () => calls;
}

describe('api client', () => {
  it('unwraps the data envelope and sends the in-memory access token', async () => {
    setSession(makeSession('admin', 'token-a'), { broadcast: false });
    const calls = protectedEndpoint('token-a');

    await expect(api('/projects')).resolves.toEqual({ items: [], page: 1, limit: 20, total: 0 });
    expect(calls).toEqual(['Bearer token-a']);
  });

  it('sends JSON bodies and includes credentials', async () => {
    let seen: { contentType: string | null; body: unknown } | null = null;
    server.use(
      http.post(`${API}/projects`, async ({ request }) => {
        seen = { contentType: request.headers.get('Content-Type'), body: await request.json() };
        return ok({ project: { id: 'p1' } }, 201);
      }),
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await api('/projects', { method: 'POST', body: { name: 'A' } });

    expect(seen).toEqual({ contentType: 'application/json', body: { name: 'A' } });
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ credentials: 'include', method: 'POST' });
    fetchSpy.mockRestore();
  });

  it('throws a typed ApiError built from the error envelope', async () => {
    const details = [{ field: 'body.name', message: 'is required' }];
    server.use(
      http.post(`${API}/projects`, () =>
        fail(400, 'VALIDATION_ERROR', 'Some fields are invalid.', details),
      ),
    );

    const error = await api('/projects', { method: 'POST', body: {} }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'Some fields are invalid.',
      details,
    });
    expect(fieldErrorsOf(error as ApiError)).toEqual({ name: 'is required' });
  });

  it('turns a non-JSON error page into a generic ApiError', async () => {
    server.use(http.get(`${API}/projects`, () => new HttpResponse('Bad gateway', { status: 502 })));

    await expect(api('/projects')).rejects.toMatchObject({ status: 502, code: 'INTERNAL_ERROR' });
  });

  it('reports an unreachable server as NETWORK_ERROR', async () => {
    server.use(http.get(`${API}/projects`, () => HttpResponse.error()));

    await expect(api('/projects')).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
  });

  it('resolves 204 responses to undefined', async () => {
    server.use(http.post(`${API}/auth/logout`, () => new HttpResponse(null, { status: 204 })));

    await expect(api('/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
  });
});

describe('refresh on 401', () => {
  it('refreshes once and retries the request with the new token', async () => {
    setSession(makeSession('admin', 'expired'), { broadcast: false });
    const calls = protectedEndpoint('fresh');
    const refreshCalls = refreshEndpoint('fresh');

    await expect(api('/projects')).resolves.toMatchObject({ total: 0 });
    expect(refreshCalls()).toBe(1);
    expect(calls).toEqual(['Bearer expired', 'Bearer fresh']);
    expect(getAccessToken()).toBe('fresh');
  });

  it('retries only once: a second 401 is returned to the caller', async () => {
    setSession(makeSession('admin', 'expired'), { broadcast: false });
    const calls = protectedEndpoint('never-valid');
    const refreshCalls = refreshEndpoint('also-rejected');

    await expect(api('/projects')).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(refreshCalls()).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it('signs out when the refresh itself is rejected', async () => {
    setSession(makeSession('admin', 'expired'), { broadcast: false });
    protectedEndpoint('fresh');
    server.use(
      http.post(`${API}/auth/refresh`, () => fail(401, 'UNAUTHORIZED', 'Session expired.')),
    );

    await expect(api('/projects')).rejects.toMatchObject({ status: 401 });
    expect(getAuthState()).toEqual({ status: 'signed-out' });
    expect(getAccessToken()).toBeNull();
  });

  it('does not refresh for auth routes (a wrong password is not an expired token)', async () => {
    const refreshCalls = refreshEndpoint('fresh');
    server.use(
      http.post(`${API}/auth/login`, () => fail(401, 'UNAUTHORIZED', 'Invalid credentials.')),
    );

    await expect(
      api('/auth/login', { method: 'POST', body: { email: 'a@b.co', password: 'x' } }),
    ).rejects.toMatchObject({ status: 401 });
    expect(refreshCalls()).toBe(0);
  });

  it('shares one refresh between three concurrent 401s (single flight)', async () => {
    setSession(makeSession('admin', 'expired'), { broadcast: false });
    const calls = protectedEndpoint('fresh');
    const refreshCalls = refreshEndpoint('fresh');

    const results = await Promise.all([api('/projects'), api('/projects'), api('/projects')]);

    expect(results).toHaveLength(3);
    expect(refreshCalls()).toBe(1);
    expect(calls.filter((auth) => auth === 'Bearer fresh')).toHaveLength(3);
  });

  it('starts a new refresh after the previous one has settled', async () => {
    const refreshCalls = refreshEndpoint('fresh');

    await refreshSession();
    await refreshSession();

    expect(refreshCalls()).toBe(2);
  });
});

describe('refresh across tabs (Web Locks)', () => {
  const realLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');

  afterEach(() => {
    if (realLocks) Object.defineProperty(navigator, 'locks', realLocks);
    else Reflect.deleteProperty(navigator, 'locks');
  });

  /** A lock manager whose lock is held "by another tab" until release() is called. */
  function installHeldLock() {
    const names: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: async (name: string, callback: () => Promise<unknown>) => {
          names.push(name);
          await held;
          return callback();
        },
      },
    });
    return { names, release };
  }

  it('refreshes under the databridge-refresh lock', async () => {
    const lock = installHeldLock();
    const refreshCalls = refreshEndpoint('fresh');

    const pending = refreshSession();
    lock.release();

    await expect(pending).resolves.toMatchObject({ accessToken: 'fresh' });
    expect(lock.names).toEqual([REFRESH_LOCK]);
    expect(refreshCalls()).toBe(1);
  });

  it('reuses the token another tab shared while this tab waited for the lock', async () => {
    const lock = installHeldLock();
    const refreshCalls = refreshEndpoint('should-not-be-used');

    const pending = refreshSession();
    // The other tab finished its refresh and broadcast the new session.
    receiveAuthMessage({
      type: 'session',
      at: Date.now(),
      session: makeSession('admin', 'shared'),
    });
    lock.release();

    await expect(pending).resolves.toMatchObject({ accessToken: 'shared' });
    expect(refreshCalls()).toBe(0);
  });
});

describe('filenameFromDisposition', () => {
  it('reads quoted, bare and UTF-8 names and drops any path', () => {
    expect(filenameFromDisposition('attachment; filename="demo-2026-11-22.csv"')).toBe(
      'demo-2026-11-22.csv',
    );
    expect(filenameFromDisposition('attachment; filename=demo.xlsx')).toBe('demo.xlsx');
    expect(filenameFromDisposition("attachment; filename*=UTF-8''my%20file.csv")).toBe(
      'my file.csv',
    );
    expect(filenameFromDisposition('attachment; filename="../../etc/passwd"')).toBe('passwd');
    expect(filenameFromDisposition('attachment')).toBeNull();
    expect(filenameFromDisposition(null)).toBeNull();
  });
});
