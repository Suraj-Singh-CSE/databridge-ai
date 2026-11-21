export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'TOO_MANY_ROWS'
  | 'UNSUPPORTED_FILE'
  | 'LIMIT_REACHED'
  | 'RATE_LIMITED'
  | 'QUEUE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

/**
 * An expected, user-facing failure. The error handler turns it into the standard envelope
 * `{ data: null, error: { code, message, details } }` with `status` as the HTTP status.
 */
export class AppError extends Error {
  override readonly name = 'AppError';

  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details: unknown = null,
  ) {
    super(message);
  }

  static validation(message: string, details: unknown = null): AppError {
    return new AppError(400, 'VALIDATION_ERROR', message, details);
  }

  static unauthorized(message = 'Authentication required.'): AppError {
    return new AppError(401, 'UNAUTHORIZED', message);
  }

  static forbidden(message = 'You do not have permission to do this.'): AppError {
    return new AppError(403, 'FORBIDDEN', message);
  }

  static notFound(message = 'Not found.'): AppError {
    return new AppError(404, 'NOT_FOUND', message);
  }

  static conflict(message: string): AppError {
    return new AppError(409, 'CONFLICT', message);
  }

  static unsupportedFile(message: string): AppError {
    return new AppError(400, 'UNSUPPORTED_FILE', message);
  }
}

/** Thrown by repositories when a unique constraint (e.g. user email) is violated. */
export class DuplicateKeyError extends Error {
  override readonly name = 'DuplicateKeyError';
}
