import type { CookieOptions, Response } from 'express';

import { REFRESH_TOKEN_TTL_MS } from './tokens.js';

export const REFRESH_COOKIE = 'db_rt';
export const AUTH_BASE_PATH = '/api/v1/auth';

function cookieOptions(secure: boolean): CookieOptions {
  return { httpOnly: true, secure, sameSite: 'strict', path: AUTH_BASE_PATH };
}

export function setRefreshCookie(res: Response, token: string, secure: boolean): void {
  res.cookie(REFRESH_COOKIE, token, { ...cookieOptions(secure), maxAge: REFRESH_TOKEN_TTL_MS });
}

export function clearRefreshCookie(res: Response, secure: boolean): void {
  res.clearCookie(REFRESH_COOKIE, cookieOptions(secure));
}
