import { http, HttpResponse } from 'msw';

import type { AuthSession, Page, Project, Role, User } from '@/lib/api-types';

export const API = '*/api/v1';

export function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: '64b000000000000000000001',
    email: 'steward@demo.dev',
    name: 'Data steward',
    role: 'data_engineer',
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    ...overrides,
  };
}

export function makeSession(role: Role = 'data_engineer', token = 'access-1'): AuthSession {
  return { user: makeUser({ role }), accessToken: token };
}

export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: '64b0000000000000000000a1',
    name: 'Customer 360 demo',
    description: '',
    ownerId: '64b000000000000000000001',
    members: [],
    status: 'active',
    currentStep: 'mapping',
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    ...overrides,
  };
}

export function page<T>(items: T[]): Page<T> {
  return { items, page: 1, limit: 100, total: items.length };
}

export function ok(data: unknown, status = 200) {
  return HttpResponse.json({ data, error: null }, { status });
}

export function fail(status: number, code: string, message: string, details: unknown = null) {
  return HttpResponse.json({ data: null, error: { code, message, details } }, { status });
}

/** Handlers for "the browser has a valid refresh cookie". */
export function signedInHandlers(session: AuthSession = makeSession()) {
  return [http.post(`${API}/auth/refresh`, () => ok(session))];
}

/** Handlers for "no cookie": refresh answers 401. */
export function signedOutHandlers() {
  return [
    http.post(`${API}/auth/refresh`, () =>
      fail(401, 'UNAUTHORIZED', 'Your session has expired. Please sign in again.'),
    ),
  ];
}
