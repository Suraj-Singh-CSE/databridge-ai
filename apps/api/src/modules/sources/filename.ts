import type { SourceFormat } from './source.types.js';

const MAX_FILENAME = 200;
const MAX_NAME = 80;

/** Control characters, zero-width and bidi-override characters (used to disguise extensions). */
function isUnsafeChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
}

function truncate(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length > max ? chars.slice(0, max).join('') : value;
}

/**
 * Makes the client's filename safe to store and display: no directories, no control or bidi
 * characters, collapsed whitespace, at most 200 characters (keeping the extension).
 * The result is for display only; storage keys never use it.
 */
export function sanitizeFilename(raw: string | undefined): string {
  const base = (raw ?? '').split(/[/\\]/).pop() ?? '';
  const cleaned = Array.from(base.normalize('NFC'))
    .filter((char) => !isUnsafeChar(char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'upload';
  const dot = cleaned.lastIndexOf('.');
  const extension = dot > 0 ? cleaned.slice(dot) : '';
  if (Array.from(cleaned).length <= MAX_FILENAME || extension.length >= MAX_FILENAME) {
    return truncate(cleaned, MAX_FILENAME);
  }
  return truncate(cleaned.slice(0, dot), MAX_FILENAME - extension.length) + extension;
}

/** Allowlist by extension: only `.csv` and `.xlsx` (not `.xls`, `.xlsm` or anything else). */
export function formatOf(filename: string): SourceFormat | null {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return null;
  const extension = filename.slice(dot + 1).toLowerCase();
  return extension === 'csv' || extension === 'xlsx' ? extension : null;
}

/** Display name used when the client sends none: the filename without its extension. */
export function defaultSourceName(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const stem = (dot > 0 ? filename.slice(0, dot) : filename).trim();
  return truncate(stem, MAX_NAME).trim() || 'Untitled source';
}
