import type { Readable } from 'node:stream';

export interface PutOptions {
  contentType: string;
}

export interface StoredObject {
  sizeBytes: number;
  /** Lowercase hex SHA-256 of the stored bytes. */
  sha256: string;
}

/**
 * Where uploaded files live. Keys are slash-separated relative paths built by the server
 * (see keys.ts), never from user input such as a filename.
 */
export interface FileStorage {
  /**
   * Streams `body` to `key`. The object becomes visible only when the whole stream was written;
   * if the stream fails, nothing is left behind and the promise rejects with the stream's error.
   */
  put(key: string, body: Readable, options: PutOptions): Promise<StoredObject>;
  /** Throws StorageNotFoundError when the object does not exist. */
  getStream(key: string): Promise<Readable>;
  /** Deletes one object; deleting a missing object is not an error. */
  delete(key: string): Promise<void>;
  /** Deletes every object whose key starts with `prefix` (which must end with "/"). */
  deletePrefix(prefix: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

export class StorageNotFoundError extends Error {
  override readonly name = 'StorageNotFoundError';
}

/** A key or prefix that is malformed or would escape the storage root. */
export class InvalidStorageKeyError extends Error {
  override readonly name = 'InvalidStorageKeyError';
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Accepts only `seg/seg/...` with safe segments; rejects "..", absolute paths and backslashes. */
export function assertValidKey(key: string): void {
  const segments = key.split('/');
  if (key.length > 512 || !segments.every((s) => SEGMENT.test(s) && s !== '..' && s !== '.')) {
    throw new InvalidStorageKeyError('invalid storage key');
  }
}

export function assertValidPrefix(prefix: string): void {
  if (!prefix.endsWith('/')) throw new InvalidStorageKeyError('a prefix must end with "/"');
  assertValidKey(prefix.slice(0, -1));
}
