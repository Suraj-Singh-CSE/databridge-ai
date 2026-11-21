import type { StatusTone } from '@/components/StatusPill';
import { ApiError } from '@/lib/api';
import type { SourceStatus } from '@/lib/api-types';

/** Same defaults as apps/api (MAX_UPLOAD_BYTES, MAX_UPLOAD_ROWS, MAX_SOURCES_PER_PROJECT). */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_UPLOAD_ROWS = 200_000;
export const MAX_SOURCES = 10;
export const ACCEPTED_EXTENSIONS = ['.csv', '.xlsx'] as const;

/** "50 MB", "1.5 MB", "512 KB", "300 bytes" (binary units, as the api words its limits). */
export function formatBytes(bytes: number): string {
  const units: [number, string][] = [
    [1024 * 1024, 'MB'],
    [1024, 'KB'],
  ];
  for (const [size, label] of units) {
    if (bytes >= size) {
      const value = bytes / size;
      return `${Number.isInteger(value) ? value : value.toFixed(1)} ${label}`;
    }
  }
  return `${bytes} bytes`;
}

export function formatCount(value: number | null): string {
  return value === null ? '—' : value.toLocaleString('en-US');
}

/** "12.5%" with at most one decimal; whole numbers without one. */
export function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

/**
 * Quick checks before sending a file, so the user hears about an obvious problem at once. The
 * api checks everything again (content sniffing, rows, zip bombs) and stays the authority.
 * Returns a plain-language problem, or null when the file can be sent.
 */
export function checkFile(file: File): string | null {
  const name = file.name.toLowerCase();
  if (!ACCEPTED_EXTENSIONS.some((extension) => name.endsWith(extension))) {
    return `"${file.name}" is not a CSV or Excel (.xlsx) file. Export your data as CSV or .xlsx and try again.`;
  }
  if (file.size === 0) return `"${file.name}" is empty.`;
  if (file.size > MAX_UPLOAD_BYTES) {
    return `"${file.name}" is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_UPLOAD_BYTES)}. Upload a smaller file or split it into parts.`;
  }
  return null;
}

/** How many more files fit in the project. */
export function roomLeft(sourceCount: number): number {
  return Math.max(0, MAX_SOURCES - sourceCount);
}

/**
 * Friendly text for a failed upload. Known codes get our own wording (stable even if the api's
 * text changes); anything else shows the api's message, which is already plain language.
 */
export function uploadErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'The upload failed. Please try again.';
  switch (error.code) {
    case 'PAYLOAD_TOO_LARGE':
      return `This file is larger than the ${formatBytes(MAX_UPLOAD_BYTES)} limit. Upload a smaller file or split it into parts.`;
    case 'TOO_MANY_ROWS':
      return 'This file has too many rows. Split it into smaller files and upload each one.';
    case 'UNSUPPORTED_FILE':
      return 'This file could not be read as CSV or Excel (.xlsx). Export it again and retry.';
    case 'FILE_TOO_COMPLEX':
      return 'This Excel file is too large once unpacked. Save it as CSV or split it, then upload it again.';
    case 'CONFLICT':
      return 'This file is already in the project.';
    case 'LIMIT_REACHED':
      return `A project can have at most ${MAX_SOURCES} files. Remove one before uploading another.`;
    case 'RATE_LIMITED':
      return 'You have uploaded many files recently. Please wait a few minutes and try again.';
    case 'FORBIDDEN':
      return 'You do not have permission to upload files to this project.';
    case 'NETWORK_ERROR':
      return 'The upload was interrupted. Check your connection and try again.';
    default:
      return error.message;
  }
}

/** Friendly text for a failed profile job or source, by error code. */
export function profileErrorMessage(error: { code: string; message: string } | null): string {
  if (!error) return 'Profiling did not finish. Try again.';
  switch (error.code) {
    case 'TOO_MANY_ROWS':
      return 'This file has too many rows to profile. Split it into smaller files and upload each one.';
    case 'TOO_MANY_COLUMNS':
      return 'This file has too many columns to profile (the limit is 500).';
    case 'FILE_TOO_COMPLEX':
      return 'This Excel file is too large once unpacked. Save it as CSV or split it, then upload it again.';
    case 'UNSUPPORTED_FILE':
      return 'This file could not be read. Save it again as CSV or .xlsx and upload it again.';
    case 'FILE_MISSING':
    case 'INVALID_SOURCE':
      return 'The stored file is missing. Remove this source and upload the file again.';
    case 'QUEUE_UNAVAILABLE':
      return 'Background work is unavailable right now. Try again in a minute.';
    case 'WORKER_LOST':
    case 'TIME_LIMIT_EXCEEDED':
    case 'RETRIES_EXHAUSTED':
      return 'Profiling stopped before it finished. Try again.';
    case 'SOURCE_NOT_FOUND':
      return 'This source no longer exists.';
    default:
      return error.message;
  }
}

/** Text and tone of a source's status pill (text always present: colour is never the only cue). */
export function sourceStatusPill(
  status: SourceStatus,
  progress?: number,
): { label: string; tone: StatusTone } {
  switch (status) {
    case 'profiling':
      return {
        label: progress === undefined ? 'Profiling' : `Profiling ${Math.round(progress)}%`,
        tone: 'review',
      };
    case 'profiled':
    case 'ready':
      return { label: 'Profiled', tone: 'high' };
    case 'failed':
      return { label: 'Failed', tone: 'low' };
    case 'uploaded':
      return { label: 'Uploaded', tone: 'neutral' };
  }
}
