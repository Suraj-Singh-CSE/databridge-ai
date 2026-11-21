import { Transform, type TransformCallback } from 'node:stream';

import { parse, type Options, type Parser } from 'csv-parse';

import { AppError } from '../../errors.js';

import { tooManyRows } from './limits.js';
import type { SourceFormat } from './source.types.js';

/** XLSX files are ZIP archives: a local file header starts with "PK\x03\x04". */
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
/** NUL bytes in the first 64 KiB mean a binary file renamed to .csv. */
const SNIFF_BYTES = 64 * 1024;
/** One CSV row may not exceed this many characters (bounds parser memory on broken quoting). */
export const MAX_CSV_RECORD_CHARS = 1024 * 1024;

export interface Inspection {
  /** Data rows (header excluded); null for XLSX (counted by the profiler in M2.4). */
  rowCount: number | null;
  columnCount: number | null;
}

/** Options shared by upload inspection and preview so both read a CSV the same way. */
export const CSV_PARSE_OPTIONS: Options = {
  bom: true,
  relax_column_count: true,
  relax_quotes: true,
  skip_empty_lines: true,
  // Accept Windows, Unix and old-Mac line endings, even mixed in one file.
  record_delimiter: ['\r\n', '\n', '\r'],
  max_record_size: MAX_CSV_RECORD_CHARS,
};

/** Turns a csv-parse error into a user-facing one without echoing any cell value. */
export function csvReadError(error: unknown): AppError {
  const line =
    typeof error === 'object' &&
    error !== null &&
    'lines' in error &&
    typeof error.lines === 'number'
      ? ` (problem near line ${error.lines})`
      : '';
  const tooLong =
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code === 'CSV_MAX_RECORD_SIZE'
      : false;
  return AppError.unsupportedFile(
    tooLong
      ? 'This CSV file has a row that is too long to read. Check that every quoted value is closed.'
      : `This CSV file could not be read${line}. Check that it is a valid comma-separated file.`,
  );
}

/**
 * Pass-through stream placed between the upload and storage. It checks the content while the
 * bytes flow (never trusting the extension or Content-Type) and fails the stream on a problem:
 * - XLSX: must start with the ZIP signature.
 * - CSV: valid UTF-8 (BOM allowed), no NUL bytes in the first 64 KiB, at least a header line,
 *   and at most `maxRows` data rows, counted by a real CSV parser so quoted newlines are handled.
 */
export class FileInspector extends Transform {
  private bytes = 0;
  private head = Buffer.alloc(0);
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private readonly csv: Parser | null;
  private readonly csvDone: Promise<void> | null;
  private records = 0;
  private columns = 0;
  private overLimit = false;

  constructor(
    private readonly format: SourceFormat,
    private readonly maxRows: number,
  ) {
    super();
    if (format === 'csv') {
      this.csv = parse({
        ...CSV_PARSE_OPTIONS,
        // Count rows and drop them at once: nothing is kept in memory.
        on_record: (record: string[]) => {
          if (this.records === 0) this.columns = record.length;
          this.records += 1;
          if (this.records - 1 > this.maxRows) this.overLimit = true;
          return null;
        },
      });
      const parser = this.csv;
      this.csvDone = new Promise((resolve, reject) => {
        parser.once('end', resolve);
        parser.once('error', reject);
      });
      this.csvDone.catch(() => undefined);
      parser.resume();
    } else {
      this.csv = null;
      this.csvDone = null;
    }
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    const checkedBefore = this.bytes;
    this.bytes += chunk.length;
    if (this.format === 'xlsx') {
      const problem = this.checkZipHead(chunk);
      if (problem) {
        done(problem);
        return;
      }
      done(null, chunk);
      return;
    }
    if (checkedBefore < SNIFF_BYTES && chunk.subarray(0, SNIFF_BYTES - checkedBefore).includes(0)) {
      done(notText());
      return;
    }
    let text: string;
    try {
      text = this.decoder.decode(chunk, { stream: true });
    } catch {
      done(notUtf8());
      return;
    }
    this.writeCsv(text, (error) => {
      done(error, error ? undefined : chunk);
    });
  }

  override _flush(done: TransformCallback): void {
    if (this.bytes === 0) {
      done(AppError.unsupportedFile('The file is empty.'));
      return;
    }
    if (this.format === 'xlsx') {
      done(this.head.length < ZIP_SIGNATURE.length ? notXlsx() : null);
      return;
    }
    let tail: string;
    try {
      tail = this.decoder.decode();
    } catch {
      done(notUtf8());
      return;
    }
    this.writeCsv(tail, (error) => {
      if (error) {
        done(error);
        return;
      }
      this.finishCsv().then(
        () => {
          done();
        },
        (finishError: unknown) => {
          done(finishError instanceof Error ? finishError : csvReadError(finishError));
        },
      );
    });
  }

  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    this.csv?.destroy();
    done(error);
  }

  /** Call after the stream finished successfully. */
  result(): Inspection {
    if (this.format === 'xlsx') return { rowCount: null, columnCount: null };
    return { rowCount: Math.max(this.records - 1, 0), columnCount: this.columns };
  }

  private checkZipHead(chunk: Buffer): AppError | null {
    if (this.head.length >= ZIP_SIGNATURE.length) return null;
    this.head = Buffer.concat([this.head, chunk]).subarray(0, ZIP_SIGNATURE.length);
    const seen = this.head.length;
    return this.head.equals(ZIP_SIGNATURE.subarray(0, seen)) ? null : notXlsx();
  }

  private writeCsv(text: string, done: (error: Error | null) => void): void {
    const parser = this.csv;
    if (!parser || text.length === 0) {
      done(this.overLimit ? tooManyRows(this.maxRows) : null);
      return;
    }
    parser.write(text, (error) => {
      if (error) {
        done(csvReadError(error));
        return;
      }
      done(this.overLimit ? tooManyRows(this.maxRows) : null);
    });
  }

  private async finishCsv(): Promise<void> {
    const parser = this.csv;
    if (!parser || !this.csvDone) return;
    parser.end();
    try {
      await this.csvDone;
    } catch (error) {
      throw csvReadError(error);
    }
    if (this.overLimit) throw tooManyRows(this.maxRows);
    if (this.records === 0) {
      throw AppError.unsupportedFile('This CSV file has no header line.');
    }
  }
}

function notXlsx(): AppError {
  return AppError.unsupportedFile(
    'This file is not a real Excel workbook (.xlsx). Save it from Excel as .xlsx, or export it as CSV.',
  );
}

function notText(): AppError {
  return AppError.unsupportedFile('This file does not look like a CSV text file.');
}

function notUtf8(): AppError {
  return AppError.unsupportedFile(
    'This CSV file is not UTF-8 encoded. Save it as "CSV UTF-8" and upload it again.',
  );
}
