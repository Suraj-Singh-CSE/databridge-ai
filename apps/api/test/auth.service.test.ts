import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { createLogger } from '../src/logger.js';
import type { AuditInput, AuditService } from '../src/modules/audit/audit.service.js';
import { createAuthService } from '../src/modules/auth/auth.service.js';
import { createTokenService, REFRESH_TOKEN_TTL_MS } from '../src/modules/auth/tokens.js';

import { fastPasswords } from './support/build-app.js';
import { createMemoryRepositories } from './support/memory-repositories.js';

const config = loadConfig({ NODE_ENV: 'test' });
const PASSWORD = 'correct horse battery';

function setup(now: () => Date = () => new Date()) {
  const repos = createMemoryRepositories();
  const recorded: AuditInput[] = [];
  const audit: AuditService = {
    record: (input) => {
      recorded.push(input);
      return Promise.resolve();
    },
  };
  const logger = createLogger(config);
  const auth = createAuthService({
    repos,
    tokens: createTokenService(config),
    passwords: fastPasswords,
    audit,
    logger,
    now,
  });
  return { auth, repos, recorded, logger };
}

describe('auth service', () => {
  it('audits register and successful login without secrets', async () => {
    const { auth, recorded } = setup();
    const session = await auth.register(
      { email: 'a@example.com', name: 'A', password: PASSWORD },
      'req-1',
    );
    await auth.login({ email: 'a@example.com', password: PASSWORD }, 'req-2');
    await expect(
      auth.login({ email: 'a@example.com', password: 'wrong password' }, 'req-3'),
    ).rejects.toThrow(AppError);

    expect(recorded).toEqual([
      expect.objectContaining({
        action: 'user.register',
        actorId: session.user.id,
        requestId: 'req-1',
      }),
      expect.objectContaining({
        action: 'auth.login',
        actorId: session.user.id,
        requestId: 'req-2',
      }),
    ]);
    const serialized = JSON.stringify(recorded);
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain(session.accessToken);
    expect(serialized).not.toContain(session.refreshToken);
  });

  it('rejects an expired refresh token', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const { auth } = setup(() => now);
    const session = await auth.register(
      { email: 'a@example.com', name: 'A', password: PASSWORD },
      'r',
    );

    now = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS + 1);
    await expect(auth.refresh(session.refreshToken)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('ends the session when one token is refreshed twice at the same time', async () => {
    const { auth, logger } = setup();
    const warn = vi.spyOn(logger, 'warn');
    const session = await auth.register(
      { email: 'a@example.com', name: 'A', password: PASSWORD },
      'r',
    );

    const results = await Promise.allSettled([
      auth.refresh(session.refreshToken),
      auth.refresh(session.refreshToken),
    ]);

    // Whatever the interleaving, no refresh token from this family may remain usable.
    expect(results.some((r) => r.status === 'rejected')).toBe(true);
    for (const result of results) {
      if (result.status === 'fulfilled') {
        await expect(auth.refresh(result.value.refreshToken)).rejects.toThrow(AppError);
      }
    }
    expect(warn).toHaveBeenCalledWith(expect.anything(), 'refresh token reuse detected');
  });

  it('rejects refresh for a user who no longer exists', async () => {
    const { auth, repos } = setup();
    const token = 'orphan-token';
    await repos.refreshTokens.create({
      userId: '0123456789abcdef01234567',
      tokenHash: createTokenService(config).hashRefreshToken(token),
      familyId: 'f',
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(auth.refresh(token)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('rejects /me for a deleted user', async () => {
    const { auth } = setup();
    await expect(auth.me('0123456789abcdef01234567')).rejects.toMatchObject({ status: 401 });
  });
});
