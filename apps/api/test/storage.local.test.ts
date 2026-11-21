import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { text } from 'node:stream/consumers';

import { describe, expect, it } from 'vitest';

import { LocalDiskStorage } from '../src/storage/local-disk.storage.js';
import { InvalidStorageKeyError, StorageNotFoundError } from '../src/storage/storage.types.js';

const OPTIONS = { contentType: 'text/csv' };

function freshStorage(): LocalDiskStorage {
  return new LocalDiskStorage(mkdtempSync(path.join(tmpdir(), 'databridge-local-')));
}

async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.relative(root, path.join(e.parentPath, e.name)))
    .sort();
}

describe('LocalDiskStorage', () => {
  it('stores a stream and reports its size and sha256', async () => {
    const storage = freshStorage();
    const key = 'projects/p1/sources/s1/original.csv';

    const stored = await storage.put(key, Readable.from(['a,b\n', '1,2\n']), OPTIONS);

    expect(stored).toEqual({
      sizeBytes: 8,
      sha256: createHash('sha256').update('a,b\n1,2\n').digest('hex'),
    });
    expect(await storage.exists(key)).toBe(true);
    expect(await text(await storage.getStream(key))).toBe('a,b\n1,2\n');
  });

  it('writes atomically: nothing is visible until the stream ends', async () => {
    const storage = freshStorage();
    const body = new PassThrough();
    const pending = storage.put('a/b/file.csv', body, OPTIONS);

    body.write('partial,data\n');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await storage.exists('a/b/file.csv')).toBe(false);

    body.end('rest\n');
    await pending;
    expect(await storage.exists('a/b/file.csv')).toBe(true);
    expect(await filesUnder(storage.root)).toEqual(['a/b/file.csv']);
  });

  it('leaves neither the target nor a temp file when the stream fails', async () => {
    const storage = freshStorage();
    const body = new PassThrough();
    const pending = storage.put('a/file.csv', body, OPTIONS);

    body.write('some bytes');
    await new Promise((resolve) => setTimeout(resolve, 20));
    body.destroy(new Error('client went away'));

    await expect(pending).rejects.toThrow('client went away');
    expect(await filesUnder(storage.root)).toEqual([]);
  });

  it('replaces an existing object in one step', async () => {
    const storage = freshStorage();
    await storage.put('a/file.csv', Readable.from(['old']), OPTIONS);
    await storage.put('a/file.csv', Readable.from(['new']), OPTIONS);

    expect(await readFile(path.join(storage.root, 'a/file.csv'), 'utf8')).toBe('new');
  });

  it.each([
    '../escape.csv',
    'a/../../escape.csv',
    'a/./b.csv',
    '/etc/passwd',
    'a\\..\\b.csv',
    'a//b.csv',
    '',
    '.hidden',
    'a/b/',
    'x'.repeat(513),
  ])('refuses the key %j', async (key) => {
    const storage = freshStorage();

    expect(() => storage.pathFor(key)).toThrow(InvalidStorageKeyError);
    await expect(storage.put(key, Readable.from(['x']), OPTIONS)).rejects.toThrow(
      InvalidStorageKeyError,
    );
    await expect(storage.getStream(key)).rejects.toThrow(InvalidStorageKeyError);
    await expect(storage.delete(key)).rejects.toThrow(InvalidStorageKeyError);
    await expect(storage.exists(key)).rejects.toThrow(InvalidStorageKeyError);
  });

  it('refuses prefixes that escape the root or do not end with a slash', async () => {
    const storage = freshStorage();

    await expect(storage.deletePrefix('../')).rejects.toThrow(InvalidStorageKeyError);
    await expect(storage.deletePrefix('projects/p1')).rejects.toThrow(InvalidStorageKeyError);
    await expect(storage.deletePrefix('/')).rejects.toThrow(InvalidStorageKeyError);
  });

  it('throws StorageNotFoundError for a missing object; delete is idempotent', async () => {
    const storage = freshStorage();

    await expect(storage.getStream('none/file.csv')).rejects.toThrow(StorageNotFoundError);
    expect(await storage.exists('none/file.csv')).toBe(false);
    await expect(storage.delete('none/file.csv')).resolves.toBeUndefined();
  });

  it('does not report a directory as an existing object', async () => {
    const storage = freshStorage();
    await storage.put('dir/file.csv', Readable.from(['x']), OPTIONS);

    expect(await storage.exists('dir')).toBe(false);
  });

  it('deletes every object under a prefix and nothing else', async () => {
    const storage = freshStorage();
    for (const key of [
      'projects/p1/sources/a/original.csv',
      'projects/p1/sources/b/original.xlsx',
      'projects/p10/sources/c/original.csv',
    ]) {
      await storage.put(key, Readable.from(['x']), OPTIONS);
    }

    await storage.deletePrefix('projects/p1/');
    await storage.deletePrefix('projects/missing/');

    expect(await filesUnder(storage.root)).toEqual(['projects/p10/sources/c/original.csv']);
  });

  it('creates its root on init and fails when the root is not a writable directory', async () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'databridge-init-'));
    const storage = new LocalDiskStorage(path.join(parent, 'nested', 'uploads'));
    await storage.init();
    await storage.put('a/file.csv', Readable.from(['x']), OPTIONS);

    const blocker = path.join(parent, 'not-a-dir');
    await writeFile(blocker, 'x');
    await expect(new LocalDiskStorage(path.join(blocker, 'uploads')).init()).rejects.toThrow();
  });
});
