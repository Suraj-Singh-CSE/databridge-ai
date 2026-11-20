import type { ErrorRequestHandler, RequestHandler } from 'express';

import { AppError } from '../errors.js';

/** Errors raised by express.json() carry a `type` and an HTTP `status`. */
function bodyParserError(err: unknown): AppError | null {
  if (typeof err !== 'object' || err === null || !('type' in err)) return null;
  if (err.type === 'entity.parse.failed') {
    return AppError.validation('Request body is not valid JSON.');
  }
  if (err.type === 'entity.too.large') {
    return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large (max 1 MB).');
  }
  return null;
}

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(AppError.notFound('Route not found.'));
};

/** Turns every error into the standard envelope; unexpected ones are logged and hidden. */
export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  const appError = err instanceof AppError ? err : bodyParserError(err);
  if (appError) {
    res.status(appError.status).json({
      data: null,
      error: { code: appError.code, message: appError.message, details: appError.details },
    });
    return;
  }
  req.log.error({ err }, 'unhandled error');
  res.status(500).json({
    data: null,
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.', details: null },
  });
};
