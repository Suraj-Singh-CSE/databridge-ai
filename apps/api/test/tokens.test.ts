import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { createTokenService } from '../src/modules/auth/tokens.js';

const config = loadConfig({ NODE_ENV: 'test' });
const tokens = createTokenService(config);
const key = new TextEncoder().encode(config.JWT_ACCESS_SECRET);

function forge(claims: Record<string, unknown>, alg = 'HS256', secret = key) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg })
    .setSubject('0123456789abcdef01234567')
    .setIssuer('databridge-api')
    .setAudience('databridge-web')
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(secret);
}

describe('access tokens', () => {
  it('round-trips user id and role, expiring in 15 minutes', async () => {
    const token = await tokens.signAccessToken({ userId: 'u1', role: 'data_steward' });
    const [, payload = ''] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      exp: number;
      iat: number;
      type: string;
      sub: string;
    };

    expect(await tokens.verifyAccessToken(token)).toEqual({ userId: 'u1', role: 'data_steward' });
    expect(claims.exp - claims.iat).toBe(15 * 60);
    expect(claims).toMatchObject({ type: 'access', sub: 'u1' });
  });

  it('rejects tokens signed with another secret', async () => {
    const other = new TextEncoder().encode('another-secret-that-is-at-least-32-chars');
    expect(
      await tokens.verifyAccessToken(
        await forge({ role: 'admin', type: 'access' }, 'HS256', other),
      ),
    ).toBeNull();
  });

  it('rejects other algorithms even with the right secret', async () => {
    const token = await forge({ role: 'admin', type: 'access' }, 'HS512');
    expect(await tokens.verifyAccessToken(token)).toBeNull();
  });

  it('rejects tokens that are not access tokens or carry an unknown role', async () => {
    expect(
      await tokens.verifyAccessToken(await forge({ role: 'admin', type: 'refresh' })),
    ).toBeNull();
    expect(
      await tokens.verifyAccessToken(await forge({ role: 'root', type: 'access' })),
    ).toBeNull();
  });

  it('rejects expired and malformed tokens', async () => {
    const expired = await new SignJWT({ role: 'admin', type: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u1')
      .setIssuer('databridge-api')
      .setAudience('databridge-web')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(key);

    expect(await tokens.verifyAccessToken(expired)).toBeNull();
    expect(await tokens.verifyAccessToken('not.a.jwt')).toBeNull();
  });
});

describe('refresh tokens', () => {
  it('are random 256-bit values', () => {
    const a = tokens.generateRefreshToken();
    expect(a).toMatch(/^[\w-]{43}$/);
    expect(tokens.generateRefreshToken()).not.toBe(a);
  });

  it('hash deterministically with the refresh secret', () => {
    const other = createTokenService({ ...config, JWT_REFRESH_SECRET: 'z'.repeat(40) });

    expect(tokens.hashRefreshToken('t')).toMatch(/^[a-f\d]{64}$/);
    expect(tokens.hashRefreshToken('t')).toBe(tokens.hashRefreshToken('t'));
    expect(other.hashRefreshToken('t')).not.toBe(tokens.hashRefreshToken('t'));
  });
});
