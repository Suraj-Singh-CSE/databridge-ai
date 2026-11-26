import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { createLogger } from '../src/logger.js';
import type { AuditInput, AuditService } from '../src/modules/audit/audit.service.js';
import {
  createAuthService,
  inviteCodeMatches,
  type AccessPolicy,
} from '../src/modules/auth/auth.service.js';
import { createTokenService, REFRESH_TOKEN_TTL_MS } from '../src/modules/auth/tokens.js';

import { fastPasswords } from './support/build-app.js';
import { createMemoryRepositories } from './support/memory-repositories.js';

const config = loadConfig({ NODE_ENV: 'test' });
const PASSWORD = 'correct horse battery';

function setup(now: () => Date = () => new Date(), access?: AccessPolicy) {
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
    ...(access ? { access } : {}),
  });
  return { auth, repos, recorded, logger };
}

const BOSS = 'boss@example.com';
const withBootstrap = (extra: Partial<AccessPolicy> = {}): AccessPolicy => ({
  bootstrapAdminEmail: BOSS,
  registrationMode: 'open',
  inviteCodes: [],
  ...extra,
});
const account = (email: string, extra: { inviteCode?: string } = {}) => ({
  email,
  name: 'Someone',
  password: PASSWORD,
  ...extra,
});

describe('bootstrap admin (BOOTSTRAP_ADMIN_EMAIL)', () => {
  it('makes nobody admin when it is not set, not even the first registrant', async () => {
    const { auth } = setup();
    const first = await auth.register(account('first@example.com'), 'r1');
    const second = await auth.register(account(BOSS), 'r2');

    expect(first.user.role).toBe('data_engineer');
    expect(second.user.role).toBe('data_engineer');
  });

  it('makes only that email admin; other users, before or after, stay data_engineer', async () => {
    const { auth, recorded } = setup(undefined, withBootstrap());
    const before = await auth.register(account('early@example.com'), 'r1');
    const boss = await auth.register(account(BOSS), 'r2');
    const after = await auth.register(account('late@example.com'), 'r3');

    expect(before.user.role).toBe('data_engineer');
    expect(boss.user.role).toBe('admin');
    expect(after.user.role).toBe('data_engineer');
    expect(recorded.filter((entry) => entry.action === 'user.bootstrap_admin')).toEqual([
      expect.objectContaining({
        actorId: boss.user.id,
        before: { role: 'data_engineer' },
        after: { role: 'admin' },
        requestId: 'r2',
      }),
    ]);
  });

  it('puts the admin role in the access token', async () => {
    const { auth } = setup(undefined, withBootstrap());
    const session = await auth.register(account(BOSS), 'r');

    const claims = await createTokenService(config).verifyAccessToken(session.accessToken);
    expect(claims?.role).toBe('admin');
  });

  it('promotes an existing account with that email when it signs in', async () => {
    const { auth, repos } = setup(undefined, withBootstrap());
    // Registered before the variable was set (e.g. on an earlier deploy).
    const existing = await repos.users.create({
      email: BOSS,
      name: 'Boss',
      role: 'data_engineer',
      passwordHash: await fastPasswords.hash(PASSWORD),
    });

    const session = await auth.login({ email: BOSS, password: PASSWORD }, 'r');

    expect(session.user).toMatchObject({ id: existing.id, role: 'admin' });
    expect((await repos.users.findById(existing.id))?.role).toBe('admin');
  });

  it('does not promote on a wrong password', async () => {
    const { auth, repos } = setup(undefined, withBootstrap());
    const existing = await repos.users.create({
      email: BOSS,
      name: 'Boss',
      role: 'viewer',
      passwordHash: await fastPasswords.hash(PASSWORD),
    });

    await expect(auth.login({ email: BOSS, password: 'wrong password' }, 'r')).rejects.toThrow();
    expect((await repos.users.findById(existing.id))?.role).toBe('viewer');
  });

  it('is a one-time claim: simultaneous sign-ins promote once', async () => {
    const { auth, repos, recorded } = setup(undefined, withBootstrap());
    await repos.users.create({
      email: BOSS,
      name: 'Boss',
      role: 'data_engineer',
      passwordHash: await fastPasswords.hash(PASSWORD),
    });

    const sessions = await Promise.all(
      [1, 2, 3].map((i) => auth.login({ email: BOSS, password: PASSWORD }, `r${i}`)),
    );

    expect(sessions.filter((s) => s.user.role === 'admin')).toHaveLength(1);
    expect(recorded.filter((entry) => entry.action === 'user.bootstrap_admin')).toHaveLength(1);
  });

  it('only lets one of two simultaneous registrations of that email succeed', async () => {
    const { auth, repos } = setup(undefined, withBootstrap());
    const results = await Promise.allSettled([
      auth.register(account(BOSS), 'r1'),
      auth.register(account(BOSS), 'r2'),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await repos.users.findByEmail(BOSS))?.role).toBe('admin');
  });

  it('does not promote anyone once the claim is used', async () => {
    const { auth, repos } = setup(undefined, withBootstrap());
    expect(await repos.users.claimBootstrapAdmin()).toBe(true);

    const session = await auth.register(account(BOSS), 'r');
    expect(session.user.role).toBe('data_engineer');
  });
});

describe('registration modes', () => {
  it('open: anyone can register without a code', async () => {
    const { auth } = setup(undefined, withBootstrap({ registrationMode: 'open' }));

    await expect(auth.register(account('a@example.com'), 'r')).resolves.toBeDefined();
  });

  it('invite: needs one of the codes; a missing or wrong code is refused', async () => {
    const access = withBootstrap({
      registrationMode: 'invite',
      inviteCodes: ['first-invite-1', 'second-invite-2'],
    });
    const { auth, repos } = setup(undefined, access);

    for (const inviteCode of [undefined, '', 'first-invite', 'FIRST-INVITE-1', 'nope-nope-nope']) {
      await expect(
        auth.register(
          account('a@example.com', inviteCode === undefined ? {} : { inviteCode }),
          'r',
        ),
      ).rejects.toMatchObject({ status: 403, code: 'INVITE_CODE_INVALID' });
    }
    expect(await repos.users.findByEmail('a@example.com')).toBeNull();

    const ok = await auth.register(
      account('a@example.com', { inviteCode: 'second-invite-2' }),
      'r',
    );
    expect(ok.user.role).toBe('data_engineer');
  });

  it('closed: nobody can register, but existing users still sign in', async () => {
    const { auth, repos } = setup(undefined, withBootstrap({ registrationMode: 'closed' }));
    await repos.users.create({
      email: 'old@example.com',
      name: 'Old',
      role: 'viewer',
      passwordHash: await fastPasswords.hash(PASSWORD),
    });

    await expect(auth.register(account(BOSS), 'r')).rejects.toMatchObject({
      status: 403,
      code: 'REGISTRATION_CLOSED',
    });
    await expect(
      auth.login({ email: 'old@example.com', password: PASSWORD }, 'r'),
    ).resolves.toBeDefined();
  });

  it('never logs or audits the invite code', async () => {
    const code = 'secret-invite-code-9';
    const { auth, recorded } = setup(
      undefined,
      withBootstrap({ registrationMode: 'invite', inviteCodes: [code] }),
    );
    await auth.register(account('a@example.com', { inviteCode: code }), 'r');

    expect(JSON.stringify(recorded)).not.toContain(code);
  });
});

describe('inviteCodeMatches', () => {
  it('matches exactly, against every code', () => {
    expect(inviteCodeMatches('abc-12345', ['zzz-00000', 'abc-12345'])).toBe(true);
    expect(inviteCodeMatches('abc-1234', ['abc-12345'])).toBe(false);
    expect(inviteCodeMatches('abc-12345 ', ['abc-12345'])).toBe(false);
    expect(inviteCodeMatches('anything', [])).toBe(false);
  });
});

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
