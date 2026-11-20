import type { RequestHandler, Request } from 'express';
import type { z } from 'zod';

import { AppError } from '../errors.js';

type Location = 'body' | 'params' | 'query';
type Schemas = Partial<Record<Location, z.ZodType>>;

export interface FieldError {
  field: string;
  message: string;
}

/**
 * Validates body, params and query with Zod. On failure responds 400 VALIDATION_ERROR with one
 * `{ field, message }` per problem (e.g. field "body.email"). On success stores the parsed
 * (coerced, trimmed, defaulted) values on `req.validated`; read them with `validated()`.
 */
export function validate(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    const errors: FieldError[] = [];
    const parsed: NonNullable<Request['validated']> = { ...req.validated };
    for (const location of ['params', 'query', 'body'] as const) {
      const schema = schemas[location];
      if (!schema) continue;
      const result = schema.safeParse(req[location] ?? {});
      if (result.success) {
        parsed[location] = result.data;
      } else {
        for (const issue of result.error.issues) {
          errors.push({ field: [location, ...issue.path].join('.'), message: issue.message });
        }
      }
    }
    if (errors.length > 0) {
      next(AppError.validation('Some fields are invalid.', errors));
      return;
    }
    req.validated = parsed;
    next();
  };
}

/** Typed access to values parsed by `validate` with the same schema. */
export function validated<S extends z.ZodType>(
  req: Request,
  location: Location,
  _schema: S,
): z.output<S> {
  if (!req.validated || !(location in req.validated)) {
    throw new Error(`validate() did not run for ${location}`);
  }
  // Safe: validate() stored the output of this exact schema at this location.
  return req.validated[location] as z.output<S>;
}
