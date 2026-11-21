/**
 * File upload with real progress. fetch() cannot report upload progress, so this uses
 * XMLHttpRequest with the same rules as lib/api.ts: bearer token, refresh cookie, the
 * `{ data, error }` envelope and one refresh-and-retry on a 401 (see ADR 0007).
 */
import { API_BASE, ApiError, unwrapEnvelope, withSessionRetry } from '@/lib/api';
import { getAccessToken } from '@/lib/session';

export interface UploadOptions {
  /** Called with 0..1 as bytes are sent. */
  onProgress?: (fraction: number) => void;
  /** Aborting rejects with a DOMException named "AbortError". */
  signal?: AbortSignal;
}

interface Attempt {
  status: number;
  body: unknown;
}

function abortError(): DOMException {
  return new DOMException('The upload was cancelled.', 'AbortError');
}

function sendOnce(path: string, form: FormData, options: UploadOptions): Promise<Attempt> {
  return new Promise((resolve, reject) => {
    const { signal, onProgress } = options;
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const xhr = new XMLHttpRequest();
    const onAbort = () => {
      xhr.abort();
    };
    const finish = () => signal?.removeEventListener('abort', onAbort);

    xhr.open('POST', new URL(API_BASE + path, window.location.origin).toString());
    xhr.withCredentials = true;
    xhr.responseType = 'json';
    xhr.setRequestHeader('Accept', 'application/json');
    const token = getAccessToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total);
    });
    xhr.addEventListener('load', () => {
      finish();
      // responseType 'json' yields null when the body is not JSON (e.g. a proxy error page).
      resolve({ status: xhr.status, body: xhr.response as unknown });
    });
    xhr.addEventListener('error', () => {
      finish();
      reject(
        new ApiError(
          0,
          'NETWORK_ERROR',
          'The upload was interrupted. Check your connection and try again.',
        ),
      );
    });
    xhr.addEventListener('abort', () => {
      finish();
      reject(abortError());
    });
    signal?.addEventListener('abort', onAbort);
    xhr.send(form);
  });
}

/**
 * POSTs `form` (multipart) to `path` under /api/v1 and returns the envelope's `data`.
 * Rejects with ApiError, or with an AbortError when `signal` aborts.
 */
export async function uploadForm<T>(
  path: string,
  form: FormData,
  options: UploadOptions = {},
): Promise<T> {
  const result = await withSessionRetry(
    () => sendOnce(path, form, options),
    (attempt) => attempt.status === 401,
  );
  return unwrapEnvelope(result.status, result.body) as T;
}
