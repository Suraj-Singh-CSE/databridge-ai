import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { HashingStream } from './hashing.js';
import {
  assertValidKey,
  assertValidPrefix,
  InvalidStorageKeyError,
  StorageNotFoundError,
  type FileStorage,
  type PutOptions,
  type StoredObject,
} from './storage.types.js';

/** World-readable so the ai-service (a different user, read-only mount) can read uploads. */
const FILE_MODE = 0o644;
const DIR_MODE = 0o755;

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/**
 * Stores objects as files under `root`. Writes go to a temporary file in the same directory and
 * are renamed into place when complete, so readers never see a half-written file.
 */
export class LocalDiskStorage implements FileStorage {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** Creates the root if needed and checks it is writable (called once at startup). */
  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: DIR_MODE });
    await access(this.root, 2 /* fs.constants.W_OK */);
  }

  /** Absolute path for a key; refuses anything that would resolve outside the root. */
  pathFor(key: string): string {
    assertValidKey(key);
    const resolved = path.resolve(this.root, key);
    if (!resolved.startsWith(this.root + path.sep)) {
      throw new InvalidStorageKeyError('storage key escapes the root');
    }
    return resolved;
  }

  /** The content type is not stored on disk (format comes from the key's extension). */
  async put(key: string, body: Readable, _options?: PutOptions): Promise<StoredObject> {
    const target = this.pathFor(key);
    await mkdir(path.dirname(target), { recursive: true, mode: DIR_MODE });
    const temp = `${target}.${randomBytes(6).toString('hex')}.partial`;
    const hashing = new HashingStream();
    try {
      await pipeline(body, hashing, createWriteStream(temp, { flags: 'wx', mode: FILE_MODE }));
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    return hashing.result();
  }

  async getStream(key: string): Promise<Readable> {
    const file = this.pathFor(key);
    try {
      await access(file);
    } catch (error) {
      if (isMissing(error)) throw new StorageNotFoundError('stored file not found');
      throw error;
    }
    return createReadStream(file);
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<void> {
    assertValidPrefix(prefix);
    await rm(this.pathFor(prefix.slice(0, -1)), { recursive: true, force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      return (await stat(this.pathFor(key))).isFile();
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }
}
