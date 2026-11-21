import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { text } from 'node:stream/consumers';

import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';

import { createS3Client, S3Storage } from '../src/storage/s3.storage.js';
import { InvalidStorageKeyError, StorageNotFoundError } from '../src/storage/storage.types.js';

const s3 = mockClient(S3Client);
const metadata = { $metadata: {} };

function storage(partSize?: number): S3Storage {
  const client = createS3Client({
    region: 'auto',
    endpoint: 'https://example-account.r2.cloudflarestorage.com',
    forcePathStyle: true,
    accessKeyId: 'test-key',
    secretAccessKey: 'test-secret',
  });
  return new S3Storage({ client, bucket: 'uploads', ...(partSize ? { partSize } : {}) });
}

const notFound = () => new NotFound({ message: 'not found', $metadata: { httpStatusCode: 404 } });

beforeEach(() => {
  s3.reset();
});

describe('S3Storage', () => {
  it('streams a small object with one PutObject and returns size and sha256', async () => {
    s3.on(PutObjectCommand).resolves(metadata);
    const body = Buffer.from('id,name\n1,Asha\n');

    const stored = await storage().put('projects/p/sources/s/original.csv', Readable.from([body]), {
      contentType: 'text/csv; charset=utf-8',
    });

    expect(stored).toEqual({
      sizeBytes: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
    });
    const [call] = s3.commandCalls(PutObjectCommand);
    expect(call?.args[0].input).toMatchObject({
      Bucket: 'uploads',
      Key: 'projects/p/sources/s/original.csv',
      ContentType: 'text/csv; charset=utf-8',
    });
  });

  it('uses a multipart upload for files larger than one part', async () => {
    s3.on(CreateMultipartUploadCommand).resolves({ ...metadata, UploadId: 'u1' });
    s3.on(UploadPartCommand).resolves({ ...metadata, ETag: '"etag"' });
    s3.on(CompleteMultipartUploadCommand).resolves(metadata);
    const part = 5 * 1024 * 1024;
    const body = Buffer.alloc(part + 10, 'a');

    const stored = await storage(part).put('big/file.csv', Readable.from([body]), {
      contentType: 'text/csv',
    });

    expect(stored.sizeBytes).toBe(body.length);
    expect(s3.commandCalls(UploadPartCommand)).toHaveLength(2);
    expect(s3.commandCalls(CompleteMultipartUploadCommand)).toHaveLength(1);
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  it('rejects and aborts when the source stream fails', async () => {
    s3.on(PutObjectCommand).resolves(metadata);
    s3.on(AbortMultipartUploadCommand).resolves(metadata);
    const body = new PassThrough();
    const pending = storage().put('a/file.csv', body, { contentType: 'text/csv' });
    body.write('partial');
    body.destroy(new Error('client went away'));

    await expect(pending).rejects.toThrow();
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  it('streams an object back and maps a missing key to StorageNotFoundError', async () => {
    s3.on(GetObjectCommand, { Key: 'a/file.csv' })
      .resolves({ ...metadata, Body: Readable.from(['hello']) as never })
      .on(GetObjectCommand, { Key: 'a/missing.csv' })
      .rejects(new NoSuchKey({ message: 'no such key', $metadata: { httpStatusCode: 404 } }))
      .on(GetObjectCommand, { Key: 'a/empty.csv' })
      .resolves(metadata);

    expect(await text(await storage().getStream('a/file.csv'))).toBe('hello');
    await expect(storage().getStream('a/missing.csv')).rejects.toThrow(StorageNotFoundError);
    await expect(storage().getStream('a/empty.csv')).rejects.toThrow('no readable body');
  });

  it('checks existence with HeadObject', async () => {
    s3.on(HeadObjectCommand, { Key: 'a/there.csv' })
      .resolves(metadata)
      .on(HeadObjectCommand, { Key: 'a/gone.csv' })
      .rejects(notFound())
      .on(HeadObjectCommand, { Key: 'a/denied.csv' })
      .rejects(
        new S3ServiceException({
          name: 'AccessDenied',
          $fault: 'client',
          $metadata: { httpStatusCode: 403 },
        }),
      );

    expect(await storage().exists('a/there.csv')).toBe(true);
    expect(await storage().exists('a/gone.csv')).toBe(false);
    await expect(storage().exists('a/denied.csv')).rejects.toThrow();
  });

  it('deletes one object', async () => {
    s3.on(DeleteObjectCommand).resolves(metadata);

    await storage().delete('a/file.csv');

    expect(s3.commandCalls(DeleteObjectCommand)[0]?.args[0].input).toEqual({
      Bucket: 'uploads',
      Key: 'a/file.csv',
    });
  });

  it('deletes a prefix page by page', async () => {
    s3.on(ListObjectsV2Command)
      .resolvesOnce({
        ...metadata,
        Contents: [{ Key: 'projects/p/a' }, { Key: 'projects/p/b' }, {}],
        IsTruncated: true,
        NextContinuationToken: 't2',
      })
      .resolvesOnce({ ...metadata, Contents: [{ Key: 'projects/p/c' }], IsTruncated: false })
      .resolves({ ...metadata, IsTruncated: false });
    s3.on(DeleteObjectsCommand).resolves(metadata);

    await storage().deletePrefix('projects/p/');
    await storage().deletePrefix('projects/empty/');

    const lists = s3.commandCalls(ListObjectsV2Command).map((c) => c.args[0].input);
    expect(lists[0]).toMatchObject({ Bucket: 'uploads', Prefix: 'projects/p/' });
    expect(lists[1]).toMatchObject({ ContinuationToken: 't2' });
    const deletes = s3.commandCalls(DeleteObjectsCommand).map((c) => c.args[0].input);
    expect(deletes.map((d) => d.Delete?.Objects?.map((o) => o.Key))).toEqual([
      ['projects/p/a', 'projects/p/b'],
      ['projects/p/c'],
    ]);
  });

  it('refuses unsafe keys and prefixes before calling S3', async () => {
    const s = storage();

    await expect(s.put('../x', Readable.from(['x']), { contentType: 'text/csv' })).rejects.toThrow(
      InvalidStorageKeyError,
    );
    await expect(s.getStream('a/../b')).rejects.toThrow(InvalidStorageKeyError);
    await expect(s.delete('/abs')).rejects.toThrow(InvalidStorageKeyError);
    await expect(s.exists('')).rejects.toThrow(InvalidStorageKeyError);
    await expect(s.deletePrefix('projects')).rejects.toThrow(InvalidStorageKeyError);
    expect(s3.calls()).toHaveLength(0);
  });

  it('builds a client with the default credential chain when no keys are given', async () => {
    const client = createS3Client({ region: 'eu-west-1', forcePathStyle: false });

    expect(await client.config.region()).toBe('eu-west-1');
  });
});
