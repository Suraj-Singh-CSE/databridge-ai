import { Router, type Request, type RequestHandler } from 'express';

import type { RegistrationMode } from '../../config.js';

import { AppError } from '../../errors.js';
import { sendData } from '../../http.js';
import { authenticate, currentUser } from '../../middleware/authenticate.js';
import { requestIdOf } from '../../middleware/request-id.js';
import { validate, validated } from '../../middleware/validate.js';

import { clearRefreshCookie, REFRESH_COOKIE, setRefreshCookie } from './auth.cookie.js';
import { loginBody, registerBody } from './auth.schemas.js';
import type { AuthService } from './auth.service.js';
import type { TokenService } from './tokens.js';

export interface AuthRouterDeps {
  auth: AuthService;
  tokens: TokenService;
  secureCookies: boolean;
  registrationMode: RegistrationMode;
  limiters: {
    /** Strict, per client IP + email: register and login (password guessing). */
    credentials: RequestHandler;
    /** Generous, per client IP: refresh, me, logout and config (normal session traffic). */
    session: RequestHandler;
  };
}

function refreshTokenFrom(req: Request): string | null {
  const cookies = req.cookies as Record<string, unknown> | undefined;
  const value = cookies?.[REFRESH_COOKIE];
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : null;
}

export function createAuthRouter({
  auth,
  tokens,
  secureCookies,
  registrationMode,
  limiters,
}: AuthRouterDeps): Router {
  const router = Router();
  const { credentials, session } = limiters;

  // Public: lets the Create account page show the invite-code field or a "closed" message.
  router.get('/config', session, (_req, res) => {
    sendData(res, { registrationMode });
  });

  router.post('/register', credentials, validate({ body: registerBody }), async (req, res) => {
    const input = validated(req, 'body', registerBody);
    const { user, accessToken, refreshToken } = await auth.register(input, requestIdOf(req));
    setRefreshCookie(res, refreshToken, secureCookies);
    sendData(res, { user, accessToken }, 201);
  });

  router.post('/login', credentials, validate({ body: loginBody }), async (req, res) => {
    const input = validated(req, 'body', loginBody);
    const { user, accessToken, refreshToken } = await auth.login(input, requestIdOf(req));
    setRefreshCookie(res, refreshToken, secureCookies);
    sendData(res, { user, accessToken });
  });

  router.post('/refresh', session, async (req, res) => {
    const token = refreshTokenFrom(req);
    if (!token) throw AppError.unauthorized('Your session has expired. Please sign in again.');
    try {
      const { user, accessToken, refreshToken } = await auth.refresh(token);
      setRefreshCookie(res, refreshToken, secureCookies);
      sendData(res, { user, accessToken });
    } catch (error) {
      clearRefreshCookie(res, secureCookies);
      throw error;
    }
  });

  router.post('/logout', session, async (req, res) => {
    const token = refreshTokenFrom(req);
    if (token) await auth.logout(token);
    clearRefreshCookie(res, secureCookies);
    res.status(204).end();
  });

  router.get('/me', session, authenticate(tokens), async (req, res) => {
    sendData(res, { user: await auth.me(currentUser(req).userId) });
  });

  return router;
}
