import type { Request } from 'express';
import busboy from 'busboy';

import { AppError } from '../../errors.js';
import type { FileStorage } from '../../storage/storage.types.js';
import type { StoredObject } from '../../storage/storage.types.js';

import { FileInspector, type Inspection } from './file-inspector.js';
import { formatOf, sanitizeFilename } from './filename.js';
import { fileTooLarge } from './limits.js';
import type { SourceFormat } from './source.types.js';

/** Text fields accepted next to the file. */
export const UPLOAD_FIELDS = ['name', 'systemName'] as const;
type UploadField = (typeof UPLOAD_FIELDS)[number];

const CONTENT_TYPES: Record<SourceFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export interface UploadOptions {
  storage: FileStorage;
  maxBytes: number;
  maxRows: number;
  /** Builds the storage key once the format is known (from server ids, never the filename). */
  keyFor(format: SourceFormat): string;
}

export interface ReceivedUpload {
  fields: Partial<Record<UploadField, string>>;
  originalFilename: string;
  format: SourceFormat;
  key: string;
  stored: StoredObject;
  inspection: Inspection;
}

interface FileInFlight {
  key: string;
  format: SourceFormat;
  originalFilename: string;
  inspector: FileInspector;
  done: Promise<StoredObject>;
}

const isUploadField = (name: string): name is UploadField =>
  (UPLOAD_FIELDS as readonly string[]).includes(name);

function fieldError(field: string, message: string): AppError {
  return AppError.validation('Some fields are invalid.', [{ field: `body.${field}`, message }]);
}

/**
 * Streams a multipart/form-data upload straight into storage (nothing is buffered whole):
 * request -> busboy -> FileInspector (sniffing, size, rows) -> storage.put.
 * Resolves once the file is stored. On any failure the stored or partial file is removed before
 * the promise rejects, so callers never have to clean up after a rejected upload.
 */
export async function receiveUpload(req: Request, options: UploadOptions): Promise<ReceivedUpload> {
  let parser: busboy.Busboy;
  try {
    parser = busboy({
      headers: req.headers,
      defParamCharset: 'utf8',
      limits: {
        files: 1,
        // busboy flags a file that *reaches* fileSize; +1 lets exactly maxBytes through.
        fileSize: options.maxBytes + 1,
        fields: UPLOAD_FIELDS.length,
        fieldSize: 1024,
      },
    });
  } catch {
    throw AppError.validation('Send the file as multipart/form-data in a field named "file".');
  }

  const fields: ReceivedUpload['fields'] = {};
  let file: FileInFlight | undefined;
  let fail: (error: unknown) => void = () => undefined;
  const failure = new Promise<never>((_resolve, reject) => {
    fail = reject;
  });
  failure.catch(() => undefined);
  const parsed = new Promise<void>((resolve) => parser.once('close', resolve));

  parser.on('field', (name, value, info) => {
    if (name === 'file') {
      fail(fieldError('file', 'must be a file'));
    } else if (!isUploadField(name)) {
      fail(fieldError(name, 'is not a recognised field'));
    } else if (info.valueTruncated) {
      fail(fieldError(name, 'is too long'));
    } else {
      fields[name] = value;
    }
  });

  parser.on('file', (name, stream, info) => {
    if (name !== 'file' || file) {
      stream.resume();
      fail(fieldError(name, 'send the file in a field named "file"'));
      return;
    }
    const originalFilename = sanitizeFilename(info.filename);
    const format = formatOf(originalFilename);
    if (!format) {
      stream.resume();
      fail(
        AppError.unsupportedFile(
          'Only .csv and .xlsx files can be uploaded. Export your data as CSV or Excel (.xlsx).',
        ),
      );
      return;
    }
    const key = options.keyFor(format);
    const inspector = new FileInspector(format, options.maxRows);
    // Failures surface through storage.put's rejection; this listener only stops an error raised
    // before put has attached its own listeners from crashing the process.
    inspector.on('error', () => undefined);
    stream.on('limit', () => inspector.destroy(fileTooLarge(options.maxBytes)));
    stream.on('error', (error: Error) => inspector.destroy(error));
    stream.pipe(inspector);
    const done = options.storage.put(key, inspector, { contentType: CONTENT_TYPES[format] });
    done.catch((error: unknown) => {
      stream.resume();
      fail(error);
    });
    file = { key, format, originalFilename, inspector, done };
  });

  parser.on('filesLimit', () => {
    fail(AppError.validation('Upload one file per request.'));
  });
  parser.on('fieldsLimit', () => {
    fail(AppError.validation('Too many form fields.'));
  });
  parser.on('error', () => {
    fail(AppError.validation('The upload could not be read. Please try again.'));
  });
  req.once('error', () => {
    fail(AppError.validation('The upload was interrupted. Please try again.'));
  });
  req.once('close', () => {
    if (!req.complete) fail(AppError.validation('The upload was interrupted. Please try again.'));
  });
  req.pipe(parser);

  try {
    await Promise.race([parsed, failure]);
    if (!file) throw fieldError('file', 'is required');
    const stored = await Promise.race([file.done, failure]);
    return {
      fields,
      originalFilename: file.originalFilename,
      format: file.format,
      key: file.key,
      stored,
      inspection: file.inspector.result(),
    };
  } catch (error) {
    req.unpipe(parser);
    req.resume();
    if (file) {
      // Stop an in-flight write so it settles (destroying with an error: a plain destroy() of a
      // finished writable can leave storage.put's pipeline waiting), then remove what was stored.
      file.inspector.destroy(new Error('upload aborted'));
      await file.done.catch(() => undefined);
      await options.storage.delete(file.key);
    }
    throw error;
  }
}
