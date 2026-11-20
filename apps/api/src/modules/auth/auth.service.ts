import { randomUUID } from 'node:crypto';

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
    input: { email: string; name: string; password: string },
    requestId: string,
  ): Promise<Session>;
  login(input: { email: string; password: string }, requestId: string): Promise<Session>;
  refresh(refreshToken: string): Promise<Session>;
  logout(refreshToken: string): Promise<void>;
  me(userId: string): Promise<User>;
}

export interface AuthServiceDeps {
  repos: Pick<Repositories, 'users' | 'refreshTokens'>;
  tokens: TokenService;
  passwords: PasswordHasher;
  audit: AuditService;
  logger: Logger;
  now?: () => Date;
}

const INVALID_CREDENTIALS = 'Email or password is incorrect.';
const INVALID_SESSION = 'Your session has expired. Please sign in again.';
const DEFAULT_ROLE: Role = 'data_engineer';

export function createAuthService(deps: AuthServiceDeps): AuthService {
  const { repos, tokens, passwords, audit, logger } = deps;
  const now = deps.now ?? (() => new Date());
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
    async register({ email, name, password }, requestId) {
      // Hash first so a duplicate email costs the same time as a new one.
      const passwordHash = await passwords.hash(password);
      const isFirstUser =
        (await repos.users.count()) === 0 && (await repos.users.claimFirstAdmin());
      let user: User;
      try {
        user = await repos.users.create({
          email,
          name,
          passwordHash,
          role: isFirstUser ? 'admin' : DEFAULT_ROLE,
        });
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
      return (await issueSession(user, randomUUID())).session;
    },

    async login({ email, password }, requestId) {
      const credentials = await repos.users.findCredentialsByEmail(email);
      const valid = await passwords.verify(
        password,
        credentials?.passwordHash ?? (await dummyHash),
      );
      if (!credentials || !valid) throw AppError.unauthorized(INVALID_CREDENTIALS);
      const { user } = credentials;
      await audit.record({
        actorId: user.id,
        action: 'auth.login',
        entityType: 'user',
        entityId: user.id,
        requestId,
      });
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
