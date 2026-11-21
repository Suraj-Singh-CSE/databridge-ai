import type { Config } from '../config.js';

import { LocalDiskStorage } from './local-disk.storage.js';
import { createS3Client, S3Storage } from './s3.storage.js';
import type { FileStorage } from './storage.types.js';

export type { FileStorage } from './storage.types.js';

type StorageConfig = Pick<
  Config,
  | 'STORAGE_DRIVER'
  | 'UPLOAD_DIR'
  | 'S3_BUCKET'
  | 'S3_REGION'
  | 'S3_ENDPOINT'
  | 'S3_FORCE_PATH_STYLE'
  | 'S3_ACCESS_KEY_ID'
  | 'S3_SECRET_ACCESS_KEY'
>;

/** Builds the storage selected by STORAGE_DRIVER (config is validated by loadConfig). */
export function createStorage(config: StorageConfig): FileStorage {
  if (config.STORAGE_DRIVER === 'local') return new LocalDiskStorage(config.UPLOAD_DIR);
  if (!config.S3_BUCKET || !config.S3_REGION) {
    throw new Error('S3_BUCKET and S3_REGION are required when STORAGE_DRIVER=s3');
  }
  return new S3Storage({
    bucket: config.S3_BUCKET,
    client: createS3Client({
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    }),
  });
}

/** Startup check: local storage must have a writable root. S3 is checked on first use. */
export async function prepareStorage(storage: FileStorage): Promise<void> {
  if (storage instanceof LocalDiskStorage) await storage.init();
}
