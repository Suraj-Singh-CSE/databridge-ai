import { pino } from 'pino';

import type { Config } from './config.js';

export function createLogger(config: Pick<Config, 'NODE_ENV'>) {
  return pino({
    name: 'api',
    level: config.NODE_ENV === 'test' ? 'silent' : 'info',
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-service-token"]',
        'res.headers["set-cookie"]',
      ],
      censor: '[REDACTED]',
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
