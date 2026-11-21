import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';

import type { StoredObject } from './storage.types.js';

/** Pass-through stream that counts bytes and computes SHA-256 of everything that flows through. */
export class HashingStream extends Transform {
  private readonly hash = createHash('sha256');
  private bytes = 0;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    this.hash.update(chunk);
    this.bytes += chunk.length;
    this.push(chunk);
    done();
  }

  /** Call only after the stream has finished. */
  result(): StoredObject {
    return { sizeBytes: this.bytes, sha256: this.hash.digest('hex') };
  }
}
