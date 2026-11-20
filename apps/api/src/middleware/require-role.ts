import type { RequestHandler } from 'express';

import { AppError } from '../errors.js';
import type { Role } from '../modules/users/user.types.js';

import { currentUser } from './authenticate.js';

/** Allows the request only when the user's global role is one of `roles`. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!roles.includes(currentUser(req).role)) {
      next(AppError.forbidden());
      return;
    }
    next();
  };
}
