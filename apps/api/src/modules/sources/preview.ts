import type { Readable } from 'node:stream';

import { parse } from 'csv-parse';
import ExcelJS from 'exceljs';

import { AppError } from '../../errors.js';

import { CSV_PARSE_OPTIONS, csvReadError } from './file-inspector.js';
import type { SourceFormat } from './source.types.js';

export const PREVIEW_MAX_ROWS = 50;
export const PREVIEW_MAX_COLUMNS = 50;
export const PREVIEW_MAX_CELL_CHARS = 200;

export interface Preview {
  columns: string[];
  rows: string[][];
}

function truncateCell(value: string): string {
  const chars = Array.from(value);
  return chars.length > PREVIEW_MAX_CELL_CHARS
    ? `${chars.slice(0, PREVIEW_MAX_CELL_CHARS - 1).join('')}…`
    : value;
}

/** First record = header. Every row is padded/cut to the same width (max 50 columns). */
export function toPreview(records: string[][], limit: number): Preview {
  const [header = [], ...body] = records;
  const rows = body.slice(0, limit);
  const width = Math.min(
    PREVIEW_MAX_COLUMNS,
    Math.max(header.length, ...rows.map((row) => row.length)),
  );
  const shape = (row: string[]) =>
    Array.from({ length: width }, (_, index) => truncateCell(row[index] ?? ''));
  return { columns: shape(header), rows: rows.map(shape) };
}

async function readCsvRecords(stream: Readable, count: number): Promise<string[][]> {
  const parser = stream.pipe(parse({ ...CSV_PARSE_OPTIONS, to: count }));
  const records: string[][] = [];
  try {
    for await (const record of parser) {
      records.push(record as string[]);
      if (records.length >= count) break;
    }
  } catch (error) {
    throw csvReadError(error);
  }
  return records;
}

type CellValue = ExcelJS.CellValue;

/** Display text of one Excel cell (formulas show their cached result). */
export function cellText(value: CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return String(value);
  if ('richText' in value) return value.richText.map((part) => part.text).join('');
  if ('hyperlink' in value) return value.text;
  if ('error' in value) return value.error;
  if ('formula' in value || 'sharedFormula' in value) {
    const result = (value as { result?: CellValue }).result;
    return result === undefined ? '' : cellText(result);
  }
  return '';
}

async function readXlsxRecords(stream: Readable, count: number): Promise<string[][]> {
  const workbook = new ExcelJS.stream.xlsx.WorkbookReader(stream, {
    worksheets: 'emit',
    sharedStrings: 'cache',
    hyperlinks: 'ignore',
    styles: 'ignore',
    entries: 'ignore',
  });
  const records: string[][] = [];
  try {
    // Only the first worksheet is previewed.
    for await (const worksheet of workbook) {
      for await (const row of worksheet) {
        const values = Array.isArray(row.values) ? row.values.slice(1) : [];
        records.push(Array.from(values, (value) => cellText(value)));
        if (records.length >= count) break;
      }
      break;
    }
  } catch {
    throw AppError.unsupportedFile('This Excel file could not be read.');
  }
  return records;
}

/** Reads the header and the first `limit` rows without loading the whole file. */
export async function readPreview(
  stream: Readable,
  format: SourceFormat,
  limit: number,
): Promise<Preview> {
  try {
    const records =
      format === 'csv'
        ? await readCsvRecords(stream, limit + 1)
        : await readXlsxRecords(stream, limit + 1);
    return toPreview(records, limit);
  } finally {
    stream.destroy();
  }
}
