import { pino } from 'pino';

import type { Config } from './config.js';
import { serializeError } from './log-serializers.js';

/** The pino options of the api logger; tests reuse them with their own destination. */
export function loggerOptions(config: Pick<Config, 'NODE_ENV'>) {
  return {
    name: 'api',
    level: config.NODE_ENV === 'test' ? 'silent' : 'info',
    // Errors keep only their name, codes and a scrubbed message (no Mongo keyValue/errmsg).
    serializers: { err: serializeError },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-service-token"]',
        'res.headers["set-cookie"]',
        // Defence in depth: request bodies are never logged, but these must never appear.
        '*.password',
        '*.inviteCode',
      ],
      censor: '[REDACTED]',
    },
  } satisfies pino.LoggerOptions;
}

export function createLogger(config: Pick<Config, 'NODE_ENV'>) {
  return pino(loggerOptions(config));
}

export type Logger = ReturnType<typeof createLogger>;
