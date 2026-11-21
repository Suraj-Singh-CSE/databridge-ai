import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import type { JobUpdate } from '@/lib/api-types';
import { parseJobUpdate, SseParser, watchJob } from '@/lib/job-events';
import { setSession } from '@/lib/session';
import { API, fail, jobFrame, makeJob, makeSession, ok, sseResponse } from '@/test/fixtures';
import { server } from '@/test/server';

const JOB_ID = '64b0000000000000000000d1';

describe('SseParser', () => {
  it('returns events as they complete, across chunk boundaries', () => {
    const parser = new SseParser();
    expect(parser.push('event: job\ndata: {"a"')).toEqual([]);
    expect(parser.push(':1}\n\nevent: job\ndata: 2\n')).toEqual([
      { event: 'job', data: '{"a":1}' },
    ]);
    expect(parser.push('\n')).toEqual([{ event: 'job', data: '2' }]);
  });

  it('skips comments, accepts CRLF and joins multi-line data', () => {
    const parser = new SseParser();
    const events = parser.push(': keep-alive\r\n\r\ndata: one\r\ndata: two\r\n\r\n');
    expect(events).toEqual([{ event: 'message', data: 'one\ntwo' }]);
  });
});

describe('parseJobUpdate', () => {
  it('accepts a valid frame and rejects anything else', () => {
    const update = parseJobUpdate(
      JSON.stringify({ jobId: 'j', status: 'running', progress: 5, message: 'Reading' }),
    );
    expect(update).toEqual({
      jobId: 'j',
      status: 'running',
      progress: 5,
      message: 'Reading',
      result: null,
      error: null,
    });
    expect(parseJobUpdate('not json')).toBeNull();
    expect(parseJobUpdate(JSON.stringify({ jobId: 'j', status: 'weird', progress: 1 }))).toBeNull();
  });
});

describe('watchJob', () => {
  function watch(retryMs = 5) {
    const updates: JobUpdate[] = [];
    const controller = new AbortController();
    const done = watchJob(JOB_ID, {
      signal: controller.signal,
      retryMs,
      onUpdate: (update) => updates.push(update),
    });
    return { updates, done, controller };
  }

  it('streams updates with the bearer token until a terminal status', async () => {
    setSession(makeSession('data_engineer', 'token-a'), { broadcast: false });
    let auth: string | null = null;
    server.use(
      http.get(`${API}/jobs/:id/events`, ({ request }) => {
        auth = request.headers.get('Authorization');
        return sseResponse([
          ': keep-alive\n\n',
          jobFrame({ status: 'running', progress: 15, message: 'Read 10 rows' }),
          jobFrame({ status: 'succeeded', progress: 100, message: 'Done' }),
        ]);
      }),
    );
    const { updates, done } = watch();

    await expect(done).resolves.toMatchObject({ status: 'succeeded', progress: 100 });
    expect(updates.map((u) => u.progress)).toEqual([15, 100]);
    expect(auth).toBe('Bearer token-a');
  });

  it('falls back to reading the job when the stream fails, then reconnects', async () => {
    let streams = 0;
    server.use(
      http.get(`${API}/jobs/:id/events`, () => {
        streams += 1;
        if (streams === 1) return HttpResponse.error();
        return sseResponse([jobFrame({ status: 'succeeded', progress: 100 })]);
      }),
      http.get(`${API}/jobs/:id`, () => ok({ job: makeJob({ progress: 60 }) })),
    );
    const { updates, done } = watch();

    await expect(done).resolves.toMatchObject({ status: 'succeeded' });
    expect(updates.map((u) => u.progress)).toEqual([60, 100]);
    expect(streams).toBe(2);
  });

  it('polls only after repeated stream failures', async () => {
    let streams = 0;
    let polls = 0;
    server.use(
      http.get(`${API}/jobs/:id/events`, () => {
        streams += 1;
        return fail(502, 'INTERNAL_ERROR', 'Bad gateway');
      }),
      http.get(`${API}/jobs/:id`, () => {
        polls += 1;
        return ok({ job: makeJob(polls < 5 ? {} : { status: 'failed', progress: 30 }) });
      }),
    );
    const { done } = watch(1);

    await expect(done).resolves.toMatchObject({ status: 'failed' });
    expect(streams).toBe(3);
    expect(polls).toBe(5);
  });

  it('reconnects after a stream that ends without a final status', async () => {
    let streams = 0;
    server.use(
      http.get(`${API}/jobs/:id/events`, () => {
        streams += 1;
        return streams === 1
          ? sseResponse([jobFrame({ status: 'running', progress: 20 })])
          : sseResponse([jobFrame({ status: 'cancelled', progress: 20 })]);
      }),
      http.get(`${API}/jobs/:id`, () => ok({ job: makeJob({ progress: 20 }) })),
    );
    const { done } = watch();

    await expect(done).resolves.toMatchObject({ status: 'cancelled' });
    expect(streams).toBe(2);
  });

  it('gives up on a 404 and stops when aborted', async () => {
    server.use(http.get(`${API}/jobs/:id/events`, () => fail(404, 'NOT_FOUND', 'Job not found.')));
    await expect(watch().done).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });

    server.use(
      http.get(`${API}/jobs/:id/events`, () =>
        sseResponse([jobFrame({ status: 'running', progress: 1 })], { keepOpen: true }),
      ),
    );
    const { done, controller, updates } = watch();
    await expect.poll(() => updates.length).toBe(1);
    controller.abort();
    await expect(done).rejects.toMatchObject({ name: 'AbortError' });
  });
});
