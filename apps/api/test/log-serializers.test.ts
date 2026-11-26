import { Writable } from 'node:stream';

import express from 'express';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { scrubMessage, serializeError } from '../src/log-serializers.js';
import { loggerOptions } from '../src/logger.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { requestLogger } from '../src/middleware/request-id.js';

const EMAIL = 'asha.rao1987@example.com';

/** Shaped like the driver's MongoServerError for a unique-index clash on users.email. */
function duplicateKeyError(): Error {
  const message = `E11000 duplicate key error collection: databridge.users index: email_1 dup key: { email: "${EMAIL}" }`;
  return Object.assign(new Error(message), {
    name: 'MongoServerError',
    code: 11000,
    codeName: 'DuplicateKey',
    errmsg: message,
    keyPattern: { email: 1 },
    keyValue: { email: EMAIL },
    errorResponse: { errmsg: message, keyValue: { email: EMAIL } },
  });
}

function capture(): { lines: string[]; stream: Writable } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  return { lines, stream };
}

describe('error log serializer', () => {
  it('keeps the name and codes but drops the duplicate key value', () => {
    const safe = serializeError(duplicateKeyError());

    expect(safe).toMatchObject({ type: 'MongoServerError', code: 11000, codeName: 'DuplicateKey' });
    expect(safe.message).toContain('dup key: [REDACTED]');
    expect(JSON.stringify(safe)).not.toContain(EMAIL);
    expect(JSON.stringify(safe)).not.toMatch(/keyValue|keyPattern|errmsg|errorResponse/);
    expect(safe.stack?.split('\n')[0]).toBe(`MongoServerError: ${safe.message}`);
  });

  it('scrubs emails and digit runs and handles non-errors', () => {
    expect(scrubMessage('mail x.y@corp.example.com or call 9820012345')).toBe(
      'mail [EMAIL] or call [NUM]',
    );
    expect(scrubMessage('x'.repeat(400))).toHaveLength(300);
    expect(serializeError(`bad ${EMAIL}`)).toEqual({ type: 'string', message: 'bad [EMAIL]' });
    expect(serializeError({ body: { email: EMAIL } })).toEqual({ type: 'object', message: '' });
    // What pino-http's wrapper passes: pino's std serializer output, own properties copied.
    const copied = {
      type: 'MongoServerError',
      message: `dup key: { email: "${EMAIL}" }`,
      keyValue: { email: EMAIL },
    };
    expect(serializeError(copied)).toEqual({
      type: 'MongoServerError',
      message: 'dup key: [REDACTED]',
    });
    const plain = new Error('boom');
    delete plain.stack;
    expect(serializeError(plain)).toEqual({ type: 'Error', message: 'boom' });
  });

  it('an unhandled duplicate-key error never logs the email or the request body', async () => {
    const { lines, stream } = capture();
    const logger = pino({ ...loggerOptions({ NODE_ENV: 'development' }) }, stream);
    const app = express();
    app.use(requestLogger(logger));
    app.use(express.json());
    app.post('/users', () => {
      throw duplicateKeyError();
    });
    app.use(errorHandler);

    const response = await request(app).post('/users').send({ email: EMAIL, name: 'Asha Rao' });

    expect(response.status).toBe(500);
    const logged = lines.join('\n');
    expect(logged).toContain('unhandled error');
    expect(logged).toContain('DuplicateKey');
    expect(logged).not.toContain(EMAIL);
    expect(logged).not.toContain('Asha Rao');
  });
});
