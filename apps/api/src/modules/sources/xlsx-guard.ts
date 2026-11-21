import type { Readable } from 'node:stream';

import unzipper from 'unzipper';

/**
 * Zip-bomb guard for XLSX previews, the same rules as the profiler's
 * (apps/ai-service/app/profiling/zip_guard.py, docs/adr/0011-column-profiling.md):
 *
 * - at most MAX_ENTRIES entries;
 * - the total uncompressed size may not exceed `maxUncompressedBytes`;
 * - once more than RATIO_FLOOR_BYTES have come out, the total may not exceed
 *   `maxCompressionRatio` times the file size.
 *
 * Every entry is really inflated and its bytes counted (sizes written in the archive can lie),
 * and the check stops at the first limit passed, so memory stays at one chunk.
 */
export const MAX_ENTRIES = 10_000;
export const RATIO_FLOOR_BYTES = 10 * 1024 * 1024;

export interface XlsxLimits {
  maxUncompressedBytes: number;
  maxCompressionRatio: number;
}

export class XlsxTooComplexError extends Error {
  override readonly name = 'XlsxTooComplexError';
}

export class XlsxUnreadableError extends Error {
  override readonly name = 'XlsxUnreadableError';
}

/** Reads `stream` (the whole workbook) to its end or to the first limit passed. */
export async function checkXlsx(
  stream: Readable,
  fileBytes: number,
  limits: XlsxLimits,
): Promise<{ entries: number; uncompressedBytes: number }> {
  const ratioCap = limits.maxCompressionRatio * Math.max(fileBytes, 1);
  const parser = stream.pipe(unzipper.Parse({ forceStream: true }));
  // A read error on the source does not reach the parser on its own.
  stream.on('error', (error) => parser.destroy(error));
  let entries = 0;
  let total = 0;
  try {
    for await (const item of parser) {
      const entry = item as unzipper.Entry;
      entries += 1;
      if (entries > MAX_ENTRIES) throw new XlsxTooComplexError('too many entries');
      for await (const chunk of entry) {
        total += (chunk as Buffer).length;
        if (total > limits.maxUncompressedBytes) {
          throw new XlsxTooComplexError('uncompressed size limit exceeded');
        }
        if (total > RATIO_FLOOR_BYTES && total > ratioCap) {
          throw new XlsxTooComplexError('compression ratio limit exceeded');
        }
      }
    }
  } catch (error) {
    if (error instanceof XlsxTooComplexError) throw error;
    throw new XlsxUnreadableError('not a readable zip archive', { cause: error });
  } finally {
    stream.destroy();
    parser.destroy();
  }
  if (entries === 0) throw new XlsxUnreadableError('no entries');
  return { entries, uncompressedBytes: total };
}
