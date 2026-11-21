import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { HashingStream } from './hashing.js';
import {
  assertValidKey,
  assertValidPrefix,
  StorageNotFoundError,
  type FileStorage,
  type PutOptions,
  type StoredObject,
} from './storage.types.js';

export interface S3StorageOptions {
  client: S3Client;
  bucket: string;
  /** Multipart part size in bytes (S3 minimum and default: 5 MiB). */
  partSize?: number;
}

export interface S3ClientOptions {
  region: string;
  endpoint?: string | undefined;
  forcePathStyle: boolean;
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
}

/** Without explicit keys the SDK's default chain applies (env, shared config, instance role). */
export function createS3Client(options: S3ClientOptions): S3Client {
  return new S3Client({
    region: options.region,
    forcePathStyle: options.forcePathStyle,
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    ...(options.accessKeyId && options.secretAccessKey
      ? {
          credentials: {
            accessKeyId: options.accessKeyId,
            secretAccessKey: options.secretAccessKey,
          },
        }
      : {}),
  });
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof S3ServiceException &&
    (error.name === 'NotFound' ||
      error.name === 'NoSuchKey' ||
      error.$metadata.httpStatusCode === 404)
  );
}

/** S3 limit for one DeleteObjects call. */
const DELETE_BATCH = 1000;

/**
 * Stores objects in an S3-compatible bucket (AWS S3, Cloudflare R2, MinIO). Uploads stream
 * through `@aws-sdk/lib-storage` (multipart for large files), so a file is never held in memory.
 * S3 makes an object visible only when its upload completes, and a failed multipart upload is
 * aborted, so no partial object is left behind.
 */
export class S3Storage implements FileStorage {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly partSize: number;

  constructor({ client, bucket, partSize = 5 * 1024 * 1024 }: S3StorageOptions) {
    this.client = client;
    this.bucket = bucket;
    this.partSize = partSize;
  }

  async put(key: string, body: Readable, { contentType }: PutOptions): Promise<StoredObject> {
    assertValidKey(key);
    const hashing = new HashingStream();
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: key, Body: hashing, ContentType: contentType },
      partSize: this.partSize,
      queueSize: 2,
      leavePartsOnError: false,
    });
    try {
      await Promise.all([pipeline(body, hashing), upload.done()]);
    } catch (error) {
      await upload.abort().catch(() => undefined);
      hashing.destroy();
      throw error;
    }
    return hashing.result();
  }

  async getStream(key: string): Promise<Readable> {
    assertValidKey(key);
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!(result.Body instanceof Readable)) throw new Error('S3 returned no readable body');
      return result.Body;
    } catch (error) {
      if (isNotFound(error)) throw new StorageNotFoundError('stored file not found');
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async deletePrefix(prefix: string): Promise<void> {
    assertValidPrefix(prefix);
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          MaxKeys: DELETE_BATCH,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      const keys = (page.Contents ?? []).flatMap((item) => (item.Key ? [{ Key: item.Key }] : []));
      if (keys.length > 0) {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: keys, Quiet: true },
          }),
        );
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }

  async exists(key: string): Promise<boolean> {
    assertValidKey(key);
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }
}
