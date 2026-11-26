import type { ErrorRequestHandler, RequestHandler } from 'express';

import { AppError } from '../errors.js';
import { isDuplicateKeyError } from '../mongo-errors.js';

/** Shown when a unique index refused a write that raced another request (G3-14). */
export const CONCURRENT_UPDATE_MESSAGE =
  'Someone else just changed this at the same time — refresh and try again.';

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
  if (isDuplicateKeyError(err)) {
    // A unique index refused a write that raced another request; the serializer drops keyValue.
    req.log.warn({ err }, 'concurrent write conflict');
  }
  const appError =
    err instanceof AppError
      ? err
      : isDuplicateKeyError(err)
        ? AppError.conflict(CONCURRENT_UPDATE_MESSAGE)
        : bodyParserError(err);
  if (appError) {
    res.status(appError.status).json({
      data: null,
      error: { code: appError.code, message: appError.message, details: appError.details },
    });
    return;
  }
  // The logger's err serializer drops Mongo keyValue/errmsg and scrubs the message (G3-19).
  req.log.error({ err }, 'unhandled error');
  res.status(500).json({
    data: null,
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.', details: null },
  });
};
