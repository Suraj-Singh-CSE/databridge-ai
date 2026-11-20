import { randomUUID } from 'node:crypto';

import express, { type ErrorRequestHandler, type Express } from 'express';
import { pinoHttp } from 'pino-http';

import type { Config } from './config.js';
import type { Logger } from './logger.js';

const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_PATTERN = /^[\w-]{1,64}$/;

export interface AppDeps {
  config: Config;
  logger: Logger;
}

export function createApp({ logger }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers[REQUEST_ID_HEADER];
        const id =
          typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)
            ? incoming
            : randomUUID();
        res.setHeader(REQUEST_ID_HEADER, id);
        return id;
      },
    }),
  );

  app.get('/api/v1/health', (_req, res) => {
    res.json({ data: { status: 'ok', service: 'api' }, error: null });
  });

  app.use((_req, res) => {
    res.status(404).json({
      data: null,
      error: { code: 'NOT_FOUND', message: 'Route not found.', details: null },
    });
  });

  const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
    req.log.error({ err }, 'unhandled error');
    res.status(500).json({
      data: null,
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.', details: null },
    });
  };
  app.use(errorHandler);

  return app;
}
