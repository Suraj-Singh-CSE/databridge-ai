import { http, HttpResponse } from 'msw';

import type {
  AuthSession,
  ColumnProfile,
  Job,
  JobUpdate,
  Page,
  Project,
  RegistrationMode,
  Role,
  Source,
  User,
} from '@/lib/api-types';

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

/** Handlers for "no cookie": refresh answers 401; registration is open. */
export function signedOutHandlers(registrationMode: RegistrationMode = 'open') {
  return [
    http.post(`${API}/auth/refresh`, () =>
      fail(401, 'UNAUTHORIZED', 'Your session has expired. Please sign in again.'),
    ),
    http.get(`${API}/auth/config`, () => ok({ registrationMode })),
  ];
}

export function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: '64b0000000000000000000c1',
    projectId: '64b0000000000000000000a1',
    name: 'crm_customers',
    systemName: null,
    originalFilename: 'crm_customers.csv',
    format: 'csv',
    sizeBytes: 15_360,
    sha256: 'a'.repeat(64),
    status: 'profiled',
    rowCount: 2014,
    columnCount: 9,
    error: null,
    profiledAt: '2026-11-21T10:05:00.000Z',
    standardisedAt: null,
    standardisation: null,
    uploadedBy: '64b000000000000000000001',
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    ...overrides,
  };
}

export function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: '64b0000000000000000000d1',
    projectId: '64b0000000000000000000a1',
    type: 'profile',
    status: 'running',
    progress: 40,
    message: 'Profiled column 3 of 9',
    payload: { sourceId: '64b0000000000000000000c1' },
    result: null,
    error: null,
    createdAt: '2026-11-21T10:00:00.000Z',
    updatedAt: '2026-11-21T10:00:00.000Z',
    ...overrides,
  };
}

export function makeColumn(overrides: Partial<ColumnProfile> = {}): ColumnProfile {
  return {
    column: 'cust_id',
    position: 0,
    inferredType: 'string',
    rowCount: 2014,
    emptyCount: 0,
    emptyPercent: 0,
    distinctCount: 2014,
    uniquePercent: 100,
    min: null,
    max: null,
    minLength: 7,
    maxLength: 7,
    avgLength: 7,
    topValues: [{ value: 'C000001', count: 1, percent: 0.05 }],
    samples: ['C000001', 'C000002'],
    patterns: [],
    flags: [
      { code: 'POSSIBLE_ID', label: 'Possible ID column', detail: 'Every value is different.' },
    ],
    personal: false,
    ...overrides,
  };
}

/** A `text/event-stream` response sending `frames` (raw SSE text); stays open if `keepOpen`. */
export function sseResponse(frames: string[], { keepOpen = false } = {}) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      if (!keepOpen) controller.close();
    },
  });
  return new HttpResponse(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
  });
}

/** One `event: job` SSE frame. */
export function jobFrame(update: Partial<JobUpdate> & Pick<JobUpdate, 'status' | 'progress'>) {
  const frame: JobUpdate = {
    jobId: '64b0000000000000000000d1',
    message: '',
    result: null,
    error: null,
    ...update,
  };
  return `event: job\ndata: ${JSON.stringify(frame)}\n\n`;
}

/** An SSE response the test writes to frame by frame (`send`), then ends (`close`). */
export function sseChannel() {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const pending: string[] = [];
  return {
    response() {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
          for (const frame of pending.splice(0)) c.enqueue(encoder.encode(frame));
        },
      });
      return new HttpResponse(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
      });
    },
    send(frame: string) {
      if (controller) controller.enqueue(encoder.encode(frame));
      else pending.push(frame);
    },
    close() {
      controller?.close();
    },
  };
}
