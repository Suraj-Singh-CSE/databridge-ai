import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api';

import {
  checkFile,
  formatBytes,
  formatPercent,
  MAX_UPLOAD_BYTES,
  profileErrorMessage,
  roomLeft,
  sourceStatusPill,
  uploadErrorMessage,
} from './source-rules';

function fileOf(name: string, size: number): File {
  const file = new File(['x'], name);
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

describe('checkFile', () => {
  it('accepts CSV and XLSX files within the size limit', () => {
    expect(checkFile(fileOf('crm.csv', 100))).toBeNull();
    expect(checkFile(fileOf('Billing.XLSX', MAX_UPLOAD_BYTES))).toBeNull();
  });

  it('explains other types, empty files and files over 50 MB', () => {
    expect(checkFile(fileOf('notes.pdf', 10))).toBe(
      '"notes.pdf" is not a CSV or Excel (.xlsx) file. Export your data as CSV or .xlsx and try again.',
    );
    expect(checkFile(fileOf('old.xls', 10))).toMatch(/not a CSV or Excel/);
    expect(checkFile(fileOf('empty.csv', 0))).toBe('"empty.csv" is empty.');
    expect(checkFile(fileOf('big.csv', MAX_UPLOAD_BYTES + 1))).toMatch(
      /^"big.csv" is 50\.0 MB; the limit is 50 MB/,
    );
  });

  it('counts room left for the 10-file limit', () => {
    expect(roomLeft(3)).toBe(7);
    expect(roomLeft(12)).toBe(0);
  });
});

describe('uploadErrorMessage', () => {
  it.each([
    ['PAYLOAD_TOO_LARGE', 413, /larger than the 50 MB limit/],
    ['TOO_MANY_ROWS', 413, /too many rows/],
    ['UNSUPPORTED_FILE', 400, /could not be read as CSV or Excel/],
    ['FILE_TOO_COMPLEX', 422, /too large once unpacked/],
    ['CONFLICT', 409, /already in the project/],
    ['LIMIT_REACHED', 409, /at most 10 files/],
    ['RATE_LIMITED', 429, /wait a few minutes/],
    ['FORBIDDEN', 403, /permission/],
    ['NETWORK_ERROR', 0, /interrupted/],
  ] as const)('maps %s to plain language', (code, status, expected) => {
    expect(uploadErrorMessage(new ApiError(status, code, 'raw'))).toMatch(expected);
  });

  it("falls back to the api's message, or a generic one", () => {
    expect(uploadErrorMessage(new ApiError(400, 'VALIDATION_ERROR', 'Name is too long.'))).toBe(
      'Name is too long.',
    );
    expect(uploadErrorMessage(new Error('boom'))).toBe('The upload failed. Please try again.');
  });
});

describe('profileErrorMessage', () => {
  it('maps profiler error codes', () => {
    expect(profileErrorMessage({ code: 'TOO_MANY_COLUMNS', message: 'x' })).toMatch(/500/);
    expect(profileErrorMessage({ code: 'FILE_MISSING', message: 'x' })).toMatch(/upload the file/);
    expect(profileErrorMessage({ code: 'WORKER_LOST', message: 'x' })).toMatch(/stopped/);
    expect(profileErrorMessage({ code: 'SOMETHING_NEW', message: 'Raw text.' })).toBe('Raw text.');
    expect(profileErrorMessage(null)).toBe('Profiling did not finish. Try again.');
  });
});

describe('formatting', () => {
  it('formats sizes, percentages and status pills', () => {
    expect(formatBytes(300)).toBe('300 bytes');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatPercent(12.345)).toBe('12.3%');
    expect(formatPercent(100)).toBe('100%');
    expect(sourceStatusPill('profiling', 63.6)).toEqual({ label: 'Profiling 64%', tone: 'review' });
    expect(sourceStatusPill('profiled')).toEqual({ label: 'Profiled', tone: 'high' });
    expect(sourceStatusPill('standardised')).toEqual({ label: 'Standardised', tone: 'high' });
    expect(sourceStatusPill('failed').label).toBe('Failed');
    expect(sourceStatusPill('uploaded').label).toBe('Uploaded');
  });
});
