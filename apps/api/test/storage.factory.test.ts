import { mkdtempSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { createStorage, prepareStorage } from '../src/storage/index.js';
import { sourceFileKey, projectPrefix } from '../src/storage/keys.js';
import { LocalDiskStorage } from '../src/storage/local-disk.storage.js';
import { S3Storage } from '../src/storage/s3.storage.js';

describe('createStorage', () => {
  it('defaults to local disk and prepares its root', async () => {
    const root = path.join(mkdtempSync(path.join(tmpdir(), 'databridge-factory-')), 'uploads');
    const storage = createStorage(loadConfig({ NODE_ENV: 'test', UPLOAD_DIR: root }));

    expect(storage).toBeInstanceOf(LocalDiskStorage);
    await prepareStorage(storage);
    expect((await stat(root)).isDirectory()).toBe(true);
  });

  it('selects S3 when STORAGE_DRIVER=s3', async () => {
    const storage = createStorage(
      loadConfig({
        NODE_ENV: 'test',
        STORAGE_DRIVER: 's3',
        S3_BUCKET: 'uploads',
        S3_REGION: 'auto',
        S3_ENDPOINT: 'http://minio:9000',
        S3_FORCE_PATH_STYLE: 'true',
        S3_ACCESS_KEY_ID: 'key',
        S3_SECRET_ACCESS_KEY: 'secret',
      }),
    );

    expect(storage).toBeInstanceOf(S3Storage);
    await expect(prepareStorage(storage)).resolves.toBeUndefined();
  });

  it('refuses an S3 configuration without bucket or region', () => {
    const config = { ...loadConfig({ NODE_ENV: 'test' }), STORAGE_DRIVER: 's3' as const };

    expect(() => createStorage(config)).toThrow(/S3_BUCKET and S3_REGION are required/);
  });
});

describe('storage keys', () => {
  it('builds keys from ids only', () => {
    expect(projectPrefix('p1')).toBe('projects/p1/');
    expect(sourceFileKey('p1', 's1', 'xlsx')).toBe('projects/p1/sources/s1/original.xlsx');
  });
});
