import { createHmac, randomBytes } from 'node:crypto';

import { SignJWT, jwtVerify } from 'jose';

import type { Config } from '../../config.js';
import { ROLES, type Role } from '../users/user.types.js';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const ALGORITHM = 'HS256';
const ISSUER = 'databridge-api';
const AUDIENCE = 'databridge-web';

export interface AccessClaims {
  userId: string;
  role: Role;
}

export interface TokenService {
  signAccessToken(claims: AccessClaims): Promise<string>;
  /** Returns the claims, or null for any invalid, expired, or non-access token. */
  verifyAccessToken(token: string): Promise<AccessClaims | null>;
  /** A new random opaque refresh token (256 bits, base64url). Only its hash is stored. */
  generateRefreshToken(): string;
  hashRefreshToken(token: string): string;
}

function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function createTokenService(
  config: Pick<Config, 'JWT_ACCESS_SECRET' | 'JWT_REFRESH_SECRET'>,
): TokenService {
  const accessKey = new TextEncoder().encode(config.JWT_ACCESS_SECRET);

  return {
    async signAccessToken({ userId, role }) {
      return new SignJWT({ role, type: 'access' })
        .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
        .setSubject(userId)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
        .sign(accessKey);
    },

    async verifyAccessToken(token) {
      try {
        const { payload } = await jwtVerify(token, accessKey, {
          algorithms: [ALGORITHM],
          issuer: ISSUER,
          audience: AUDIENCE,
          requiredClaims: ['sub', 'exp', 'iat'],
        });
        if (payload.type !== 'access' || !payload.sub || !isRole(payload.role)) return null;
        return { userId: payload.sub, role: payload.role };
      } catch {
        return null;
      }
    },

    generateRefreshToken() {
      return randomBytes(32).toString('base64url');
    },

    // Keyed SHA-256 (HMAC) with JWT_REFRESH_SECRET: a leaked database alone cannot be used to
    // check guesses, and rotating the secret invalidates every session at once.
    hashRefreshToken(token) {
      return createHmac('sha256', config.JWT_REFRESH_SECRET).update(token).digest('hex');
    },
  };
}
