import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { FileInspector, csvReadError } from '../src/modules/sources/file-inspector.js';
import { defaultSourceName, formatOf, sanitizeFilename } from '../src/modules/sources/filename.js';
import { formatBytes } from '../src/modules/sources/limits.js';
import { cellText, readPreview, toPreview } from '../src/modules/sources/preview.js';

async function inspect(format: 'csv' | 'xlsx', data: Buffer | string[], maxRows = 100) {
  const inspector = new FileInspector(format, maxRows);
  const source = Array.isArray(data)
    ? Readable.from(data.map((c) => Buffer.from(c)))
    : Readable.from([data]);
  source.pipe(inspector);
  for await (const _chunk of inspector) {
    // drain
  }
  return inspector.result();
}

describe('sanitizeFilename', () => {
  it.each([
    ['C:\\Users\\me\\Desktop\\crm.csv', 'crm.csv'],
    ['../../etc/passwd.csv', 'passwd.csv'],
    ['  my   export\t.csv ', 'my export.csv'],
    ['inv\u202Eoice\u0000.csv', 'invoice.csv'],
    ['', 'upload'],
    [undefined, 'upload'],
    ['\u0007', 'upload'],
    ['Cafe\u0301.csv', 'Café.csv'],
  ])('%j -> %j', (raw, expected) => {
    expect(sanitizeFilename(raw)).toBe(expected);
  });

  it('keeps the extension when shortening to 200 characters', () => {
    const name = sanitizeFilename(`${'a'.repeat(300)}.xlsx`);

    expect(name).toHaveLength(200);
    expect(name.endsWith('.xlsx')).toBe(true);
    expect(sanitizeFilename(`x.${'b'.repeat(250)}`)).toHaveLength(200);
  });
});

describe('formatOf / defaultSourceName / formatBytes', () => {
  it('allows only .csv and .xlsx', () => {
    expect(formatOf('a.CSV')).toBe('csv');
    expect(formatOf('a.b.xlsx')).toBe('xlsx');
    expect(formatOf('a.xls')).toBeNull();
    expect(formatOf('a.xlsm')).toBeNull();
    expect(formatOf('csv')).toBeNull();
  });

  it('derives a display name from the filename', () => {
    expect(defaultSourceName('crm_customers.csv')).toBe('crm_customers');
    expect(defaultSourceName('.csv')).toBe('.csv');
    expect(defaultSourceName(' .xlsx')).toBe('Untitled source');
    expect(Array.from(defaultSourceName(`${'n'.repeat(100)}.csv`))).toHaveLength(80);
  });

  it('formats byte limits for people', () => {
    expect(formatBytes(50 * 1024 * 1024)).toBe('50 MB');
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(300)).toBe('300 bytes');
  });
});

describe('FileInspector', () => {
  it('counts rows when a quoted newline spans chunk boundaries', async () => {
    const result = await inspect('csv', ['id,na', 'me\n1,"first line', '\nsecond line"\n2,b\n']);

    expect(result).toEqual({ rowCount: 2, columnCount: 2 });
  });

  it('accepts a UTF-8 multi-byte character split between chunks', async () => {
    const e = Buffer.from('é');
    const inspector = new FileInspector('csv', 10);
    const source = Readable.from([
      Buffer.from('id\n'),
      e.subarray(0, 1),
      e.subarray(1),
      Buffer.from('\n'),
    ]);
    source.pipe(inspector);
    for await (const _chunk of inspector) {
      // drain
    }
    expect(inspector.result()).toEqual({ rowCount: 1, columnCount: 1 });
  });

  it('rejects a file that ends in the middle of a UTF-8 character', async () => {
    await expect(inspect('csv', Buffer.from([0x69, 0x64, 0x0a, 0xc3]))).rejects.toThrow(
      /not UTF-8/,
    );
  });

  it('finds NUL bytes only within the first 64 KiB', async () => {
    const late = Buffer.concat([
      Buffer.from('id\n'),
      Buffer.alloc(70 * 1024, 'a'),
      Buffer.from([0]),
      Buffer.from('\n'),
    ]);

    await expect(inspect('csv', late)).resolves.toMatchObject({ rowCount: 1 });
    await expect(inspect('csv', Buffer.from('id\n\0\n'))).rejects.toThrow(
      /does not look like a CSV/,
    );
  });

  it('checks the ZIP signature even when it arrives one byte at a time', async () => {
    await expect(inspect('xlsx', ['P', 'K', '\x03', '\x04', 'rest'])).resolves.toEqual({
      rowCount: null,
      columnCount: null,
    });
    await expect(inspect('xlsx', ['P', 'X'])).rejects.toThrow(/not a real Excel workbook/);
  });

  it('rejects an over-long CSV row without echoing its content', async () => {
    const huge = Buffer.from(`id\n"${'s'.repeat(1024 * 1024 + 10)}"\n`);

    await expect(inspect('csv', huge)).rejects.toThrow(/row that is too long/);
  });

  it('describes parser errors without values', () => {
    expect(csvReadError({ lines: 4 }).message).toMatch(/near line 4/);
    expect(csvReadError(new Error('secret value')).message).not.toMatch(/secret/);
  });
});

describe('preview helpers', () => {
  it('shapes rows to the widest row (max 50) and pads short ones', () => {
    expect(toPreview([['a', 'b'], ['1'], ['1', '2', '3']], 10)).toEqual({
      columns: ['a', 'b', ''],
      rows: [
        ['1', '', ''],
        ['1', '2', '3'],
      ],
    });
    expect(toPreview([], 5)).toEqual({ columns: [], rows: [] });
  });

  it('renders Excel cell values as text', () => {
    expect(cellText(null)).toBe('');
    expect(cellText(42)).toBe('42');
    expect(cellText(true)).toBe('true');
    expect(cellText(new Date('2024-01-02T03:04:05Z'))).toBe('2024-01-02T03:04:05.000Z');
    expect(cellText({ richText: [{ text: 'Hello ' }, { text: 'world' }] })).toBe('Hello world');
    expect(cellText({ text: 'site', hyperlink: 'https://example.com' })).toBe('site');
    expect(cellText({ error: '#N/A' })).toBe('#N/A');
    expect(cellText({ formula: 'A1*2', result: 8, date1904: false })).toBe('8');
    expect(cellText({ formula: 'A1*2', date1904: false })).toBe('');
    expect(cellText({} as never)).toBe('');
  });

  it('reports an unreadable workbook as UNSUPPORTED_FILE', async () => {
    const notZip = Readable.from([Buffer.from('PK\x03\x04 but not really a zip archive')]);

    await expect(readPreview(notZip, 'xlsx', 5)).rejects.toMatchObject({
      code: 'UNSUPPORTED_FILE',
    });
  });

  it('reports a malformed CSV as UNSUPPORTED_FILE', async () => {
    const broken = Readable.from([Buffer.from('id\n"open\n')]);

    await expect(readPreview(broken, 'csv', 5)).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' });
  });
});
