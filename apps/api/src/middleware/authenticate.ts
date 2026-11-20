import type { Request, RequestHandler } from 'express';

import { AppError } from '../errors.js';
import type { AccessClaims, TokenService } from '../modules/auth/tokens.js';

const BEARER = /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/;

/** Requires a valid `Authorization: Bearer <access JWT>` and sets `req.user`. */
export function authenticate(tokens: TokenService): RequestHandler {
  return async (req, _res, next) => {
    const match = BEARER.exec(req.headers.authorization ?? '');
    const claims = match?.[1] ? await tokens.verifyAccessToken(match[1]) : null;
    if (!claims) {
      next(AppError.unauthorized('Sign in to continue.'));
      return;
    }
    req.user = claims;
    next();
  };
}

/** The authenticated user; only call after `authenticate`. */
export function currentUser(req: Request): AccessClaims {
  if (!req.user) throw new Error('authenticate() must run before currentUser()');
  return req.user;
}
