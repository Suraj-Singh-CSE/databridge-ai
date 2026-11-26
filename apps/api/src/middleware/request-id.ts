import { randomUUID } from 'node:crypto';

import type { Request } from 'express';
import { pinoHttp } from 'pino-http';

import { serializeError } from '../log-serializers.js';
import type { Logger } from '../logger.js';

const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_PATTERN = /^[\w-]{1,64}$/;

/** Structured request logging; accepts a safe incoming x-request-id or generates one. */
export function requestLogger(logger: Logger) {
  return pinoHttp({
    logger,
    // pino-http installs its own err serializer; keep the scrubbing one (G3-19).
    serializers: { err: serializeError },
    genReqId: (req, res) => {
      const incoming = req.headers[REQUEST_ID_HEADER];
      const id =
        typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
      res.setHeader(REQUEST_ID_HEADER, id);
      return id;
    },
  });
}

/** The id assigned by `requestLogger` (always a string, see genReqId above). */
export function requestIdOf(req: Request): string {
  const id = req.id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : 'unknown';
}
