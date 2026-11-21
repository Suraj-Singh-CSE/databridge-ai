import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  checkXlsx,
  XlsxTooComplexError,
  XlsxUnreadableError,
  type XlsxLimits,
} from '../src/modules/sources/xlsx-guard.js';

import { makeZip, zipBomb } from './support/zip.js';

const MIB = 1024 * 1024;
const LIMITS: XlsxLimits = { maxUncompressedBytes: 200 * MIB, maxCompressionRatio: 100 };
const SAMPLE = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../eval/samples/billing_export.xlsx',
  ),
);

const check = (file: Buffer, limits = LIMITS) =>
  checkXlsx(Readable.from([file]), file.length, limits);

describe('checkXlsx (zip-bomb guard)', () => {
  it('accepts a real workbook and measures its inflated size', async () => {
    const report = await check(SAMPLE);

    expect(report.entries).toBe(10);
    expect(report.uncompressedBytes).toBeGreaterThan(SAMPLE.length);
  });

  it('rejects a small file that inflates far beyond the compression ratio', async () => {
    const bomb = zipBomb(12 * MIB);
    expect(bomb.length).toBeLessThan(100 * 1024);

    await expect(check(bomb)).rejects.toThrow(XlsxTooComplexError);
    await expect(check(bomb)).rejects.toThrow('compression ratio');
  });

  it('allows very compressible files under the 10 MiB floor', async () => {
    const report = await check(zipBomb(2 * MIB));

    expect(report.uncompressedBytes).toBeGreaterThan(2 * MIB);
  });

  it('rejects more than the uncompressed cap', async () => {
    const limits = { maxUncompressedBytes: 2 * MIB, maxCompressionRatio: 10_000 };

    await expect(check(zipBomb(3 * MIB), limits)).rejects.toThrow('uncompressed size');
  });

  it('counts real bytes, not the sizes the archive declares', async () => {
    const liar = zipBomb(3 * MIB, 100);
    const limits = { maxUncompressedBytes: 2 * MIB, maxCompressionRatio: 10_000 };

    await expect(check(liar, limits)).rejects.toThrow(XlsxTooComplexError);
  });

  it('rejects archives with too many entries', async () => {
    const many = makeZip(
      Array.from({ length: 10_001 }, (_, i) => ({ name: `f${i}`, data: Buffer.from('x') })),
    );

    await expect(check(many)).rejects.toThrow('too many entries');
  });

  it('rejects files that are not readable zip archives', async () => {
    await expect(check(Buffer.from('PK\x03\x04 broken beyond repair'))).rejects.toThrow(
      XlsxUnreadableError,
    );
    await expect(check(makeZip([]))).rejects.toThrow(XlsxUnreadableError);
  });

  it('reports a failing source stream as unreadable', async () => {
    const failing = new Readable({
      read() {
        this.destroy(new Error('disk gone'));
      },
    });

    await expect(checkXlsx(failing, 10, LIMITS)).rejects.toThrow(XlsxUnreadableError);
  });
});
