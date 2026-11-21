import { AppError } from '../../errors.js';

/** "50 MB", "1.5 MB", "512 KB", "300 bytes" (binary units, labelled the way people read them). */
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

export function fileTooLarge(maxBytes: number): AppError {
  return new AppError(
    413,
    'PAYLOAD_TOO_LARGE',
    `This file is larger than the ${formatBytes(maxBytes)} limit. Upload a smaller file or split it into parts.`,
  );
}

export function tooManyRows(maxRows: number): AppError {
  return new AppError(
    413,
    'TOO_MANY_ROWS',
    `This file has more than ${maxRows.toLocaleString('en-US')} data rows. Split it into smaller files and upload each one.`,
  );
}

export function fileTooComplex(maxUncompressedBytes: number): AppError {
  return new AppError(
    422,
    'FILE_TOO_COMPLEX',
    `This Excel file is too large once unpacked (the limit is ${formatBytes(maxUncompressedBytes)}) or is compressed unusually much. Save it as CSV or split it, then upload it again.`,
  );
}

export function sourceLimitReached(max: number): AppError {
  return new AppError(
    409,
    'LIMIT_REACHED',
    `A project can have at most ${max} sources. Delete one before uploading another.`,
  );
}
