import { http } from 'msw';
import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api';
import { setSession } from '@/lib/session';
import { uploadForm } from '@/lib/upload';
import { installFakeXhr } from '@/test/fake-xhr';
import { API, makeSession, ok } from '@/test/fixtures';
import { server } from '@/test/server';

function form(): FormData {
  const data = new FormData();
  data.append('file', new File(['a,b\n1,2\n'], 'a.csv'));
  return data;
}

describe('uploadForm', () => {
  it('sends the file with the token and cookie and reports progress', async () => {
    const requests = installFakeXhr();
    setSession(makeSession('data_engineer', 'token-a'), { broadcast: false });
    const progress: number[] = [];

    const result = uploadForm<{ id: string }>('/projects/p/sources', form(), {
      onProgress: (fraction) => progress.push(fraction),
    });
    const xhr = requests[0];
    if (!xhr) throw new Error('no request');
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toMatch(/\/api\/v1\/projects\/p\/sources$/);
    expect(xhr.withCredentials).toBe(true);
    expect(xhr.headers.get('Authorization')).toBe('Bearer token-a');

    xhr.progress(25, 100);
    xhr.progress(100, 100);
    xhr.respond(201, { data: { id: 's1' }, error: null });

    await expect(result).resolves.toEqual({ id: 's1' });
    expect(progress).toEqual([0.25, 1]);
  });

  it('turns an error envelope into ApiError', async () => {
    const requests = installFakeXhr();
    const result = uploadForm('/x', form());
    requests[0]?.respond(413, {
      data: null,
      error: { code: 'TOO_MANY_ROWS', message: 'Too many rows.', details: null },
    });
    await expect(result).rejects.toMatchObject({ status: 413, code: 'TOO_MANY_ROWS' });
  });

  it('refreshes the session once on a 401 and sends again', async () => {
    const requests = installFakeXhr();
    setSession(makeSession('data_engineer', 'old'), { broadcast: false });
    server.use(http.post(`${API}/auth/refresh`, () => ok(makeSession('data_engineer', 'new'))));

    const result = uploadForm<{ ok: boolean }>('/x', form());
    requests[0]?.respond(401, {
      data: null,
      error: { code: 'UNAUTHORIZED', message: 'Expired.', details: null },
    });
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1]?.headers.get('Authorization')).toBe('Bearer new');
    requests[1]?.respond(201, { data: { ok: true }, error: null });
    await expect(result).resolves.toEqual({ ok: true });
  });

  it('rejects with AbortError when cancelled and with ApiError on a network failure', async () => {
    const requests = installFakeXhr();
    const controller = new AbortController();
    const cancelled = uploadForm('/x', form(), { signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(requests[0]?.aborted).toBe(true);

    const broken = uploadForm('/x', form());
    requests[1]?.fail();
    await expect(broken).rejects.toBeInstanceOf(ApiError);
  });

  it('treats a non-JSON answer as a generic error', async () => {
    const requests = installFakeXhr();
    const result = uploadForm('/x', form());
    requests[0]?.respond(502, null);
    await expect(result).rejects.toMatchObject({ status: 502, code: 'INTERNAL_ERROR' });
  });
});
