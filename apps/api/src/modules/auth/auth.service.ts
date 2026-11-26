import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import type { RegistrationMode } from '../../config.js';

import { AppError, DuplicateKeyError } from '../../errors.js';
import type { Logger } from '../../logger.js';
import type { Repositories } from '../../repositories.js';
import type { AuditService } from '../audit/audit.service.js';
import type { Role, User } from '../users/user.types.js';

import type { PasswordHasher } from './password.js';
import { REFRESH_TOKEN_TTL_MS, type TokenService } from './tokens.js';

export interface Session {
  user: User;
  accessToken: string;
  refreshToken: string;
}

export interface AuthService {
  register(
    input: { email: string; name: string; password: string; inviteCode?: string | undefined },
    requestId: string,
  ): Promise<Session>;
  login(input: { email: string; password: string }, requestId: string): Promise<Session>;
  refresh(refreshToken: string): Promise<Session>;
  logout(refreshToken: string): Promise<void>;
  me(userId: string): Promise<User>;
}

/** Who may register, and who becomes admin (ADR 0027). */
export interface AccessPolicy {
  /** Lower-case email of the one user who becomes admin; undefined = nobody automatically. */
  bootstrapAdminEmail?: string | undefined;
  registrationMode: RegistrationMode;
  /** Accepted invite codes when registrationMode is "invite". Never logged. */
  inviteCodes: readonly string[];
}

export interface AuthServiceDeps {
  repos: Pick<Repositories, 'users' | 'refreshTokens'>;
  tokens: TokenService;
  passwords: PasswordHasher;
  audit: AuditService;
  logger: Logger;
  /** Defaults to open registration and no bootstrap admin. */
  access?: AccessPolicy;
  now?: () => Date;
}

const OPEN_ACCESS: AccessPolicy = { registrationMode: 'open', inviteCodes: [] };

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/**
 * True when `given` equals one of `codes`. Compares fixed-length digests with timingSafeEqual
 * and always checks every code, so the time taken does not reveal how much of a code matched.
 */
export function inviteCodeMatches(given: string, codes: readonly string[]): boolean {
  const digest = sha256(given);
  let matched = false;
  for (const code of codes) matched = timingSafeEqual(digest, sha256(code)) || matched;
  return matched;
}

const INVALID_CREDENTIALS = 'Email or password is incorrect.';
const INVALID_SESSION = 'Your session has expired. Please sign in again.';
const DEFAULT_ROLE: Role = 'data_engineer';

export function createAuthService(deps: AuthServiceDeps): AuthService {
  const { repos, tokens, passwords, audit, logger } = deps;
  const access = deps.access ?? OPEN_ACCESS;
  const now = deps.now ?? (() => new Date());

  function checkRegistrationAllowed(inviteCode: string | undefined): void {
    if (access.registrationMode === 'closed') {
      throw new AppError(
        403,
        'REGISTRATION_CLOSED',
        'New accounts are not being created right now. Ask an admin for access.',
      );
    }
    if (
      access.registrationMode === 'invite' &&
      !(inviteCode && inviteCodeMatches(inviteCode, access.inviteCodes))
    ) {
      throw new AppError(
        403,
        'INVITE_CODE_INVALID',
        'That invite code is not valid. Check it and try again.',
      );
    }
  }

  /**
   * Promotes the user to admin when their email is exactly BOOTSTRAP_ADMIN_EMAIL and the
   * one-time claim is still free. Runs after a successful register or login, so only someone
   * who owns that account (knows its password) can trigger it.
   */
  async function promoteIfBootstrapAdmin(user: User, requestId: string): Promise<User> {
    const email = access.bootstrapAdminEmail;
    if (!email || user.role === 'admin' || user.email.toLowerCase() !== email) return user;
    if (!(await repos.users.claimBootstrapAdmin())) return user;
    const promoted = await repos.users.setRole(user.id, 'admin');
    if (!promoted) return user;
    await audit.record({
      actorId: user.id,
      action: 'user.bootstrap_admin',
      entityType: 'user',
      entityId: user.id,
      before: { role: user.role },
      after: { role: promoted.role },
      requestId,
    });
    logger.info({ userId: user.id }, 'bootstrap admin claimed');
    return promoted;
  }
  // Compared against when the email is unknown, so both failure paths cost one bcrypt check.
  const dummyHash = passwords.hash(randomUUID());

  /** Creates a refresh token in `familyId` and a matching access token. */
  async function issueSession(
    user: User,
    familyId: string,
  ): Promise<{ session: Session; refreshTokenId: string }> {
    const refreshToken = tokens.generateRefreshToken();
    const record = await repos.refreshTokens.create({
      userId: user.id,
      tokenHash: tokens.hashRefreshToken(refreshToken),
      familyId,
      expiresAt: new Date(now().getTime() + REFRESH_TOKEN_TTL_MS),
    });
    const accessToken = await tokens.signAccessToken({ userId: user.id, role: user.role });
    return { session: { user, accessToken, refreshToken }, refreshTokenId: record.id };
  }

  return {
    async register({ email, name, password, inviteCode }, requestId) {
      checkRegistrationAllowed(inviteCode);
      // Hash first so a duplicate email costs the same time as a new one.
      const passwordHash = await passwords.hash(password);
      let user: User;
      try {
        user = await repos.users.create({ email, name, passwordHash, role: DEFAULT_ROLE });
      } catch (error) {
        if (error instanceof DuplicateKeyError) {
          throw AppError.conflict('An account with this email already exists.');
        }
        throw error;
      }
      await audit.record({
        actorId: user.id,
        action: 'user.register',
        entityType: 'user',
        entityId: user.id,
        after: { role: user.role },
        requestId,
      });
      user = await promoteIfBootstrapAdmin(user, requestId);
      return (await issueSession(user, randomUUID())).session;
    },

    async login({ email, password }, requestId) {
      const credentials = await repos.users.findCredentialsByEmail(email);
      const valid = await passwords.verify(
        password,
        credentials?.passwordHash ?? (await dummyHash),
      );
      if (!credentials || !valid) throw AppError.unauthorized(INVALID_CREDENTIALS);
      await audit.record({
        actorId: credentials.user.id,
        action: 'auth.login',
        entityType: 'user',
        entityId: credentials.user.id,
        requestId,
      });
      // Also here, for a bootstrap account that registered before the variable was set.
      const user = await promoteIfBootstrapAdmin(credentials.user, requestId);
      return (await issueSession(user, randomUUID())).session;
    },

    async refresh(refreshToken) {
      const at = now();
      const record = await repos.refreshTokens.findByHash(tokens.hashRefreshToken(refreshToken));
      if (!record) throw AppError.unauthorized(INVALID_SESSION);

      // A revoked token being presented again means it was copied: end the whole session family.
      const claimed =
        record.revokedAt === null && (await repos.refreshTokens.revoke(record.id, at));
      if (!claimed) {
        await repos.refreshTokens.revokeFamily(record.familyId, at);
        logger.warn(
          { userId: record.userId, familyId: record.familyId },
          'refresh token reuse detected',
        );
        throw AppError.unauthorized(INVALID_SESSION);
      }
      if (record.expiresAt <= at) throw AppError.unauthorized(INVALID_SESSION);

      const user = await repos.users.findById(record.userId);
      if (!user) throw AppError.unauthorized(INVALID_SESSION);

      const { session, refreshTokenId } = await issueSession(user, record.familyId);
      await repos.refreshTokens.setReplacedBy(record.id, refreshTokenId);
      // A concurrent replay may have revoked the family just before our new token existed.
      if (await repos.refreshTokens.isFamilyCompromised(record.familyId)) {
        await repos.refreshTokens.revoke(refreshTokenId, at);
        throw AppError.unauthorized(INVALID_SESSION);
      }
      return session;
    },

    async logout(refreshToken) {
      const record = await repos.refreshTokens.findByHash(tokens.hashRefreshToken(refreshToken));
      if (record) await repos.refreshTokens.revoke(record.id, now());
    },

    async me(userId) {
      const user = await repos.users.findById(userId);
      if (!user) throw AppError.unauthorized('Sign in to continue.');
      return user;
    },
  };
}
