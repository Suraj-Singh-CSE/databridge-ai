import { randomBytes } from 'node:crypto';

import { DuplicateKeyError } from '../../src/errors.js';
import type { AuditEntry } from '../../src/modules/audit/audit.types.js';
import type { RefreshTokenRecord } from '../../src/modules/auth/refresh-token.types.js';
import type { Project } from '../../src/modules/projects/project.types.js';
import type { User } from '../../src/modules/users/user.types.js';
import type { Repositories } from '../../src/repositories.js';

/** 24-hex ids, like MongoDB ObjectIds, so the same route validation applies. */
const newId = () => randomBytes(12).toString('hex');

/** Ever-increasing timestamps so "newest first" ordering is deterministic. */
let clock = Date.now();
const tick = () => new Date((clock += 1));

/**
 * In-memory implementations of every repository with the same contract as the Mongo ones.
 * Used to run the full API suite without a database; the same suite also runs against MongoDB.
 */
export function createMemoryRepositories(): Repositories {
  const users = new Map<string, User & { passwordHash: string }>();
  const tokens = new Map<string, RefreshTokenRecord>();
  const projects = new Map<string, Project>();
  const audit: AuditEntry[] = [];
  let firstAdminClaimed = false;

  const publicUser = ({ passwordHash: _hash, ...user }: User & { passwordHash: string }): User =>
    structuredClone(user);
  const byEmail = (email: string) => [...users.values()].find((u) => u.email === email);
  const clone = (project: Project | undefined) => (project ? structuredClone(project) : null);

  return {
    users: {
      async create(input) {
        await Promise.resolve();
        if (byEmail(input.email)) throw new DuplicateKeyError('email already registered');
        const at = tick();
        const user = { id: newId(), ...input, createdAt: at, updatedAt: at };
        users.set(user.id, user);
        return publicUser(user);
      },
      async findById(id) {
        await Promise.resolve();
        const user = users.get(id);
        return user ? publicUser(user) : null;
      },
      async findByEmail(email) {
        await Promise.resolve();
        const user = byEmail(email);
        return user ? publicUser(user) : null;
      },
      async findCredentialsByEmail(email) {
        await Promise.resolve();
        const user = byEmail(email);
        return user ? { user: publicUser(user), passwordHash: user.passwordHash } : null;
      },
      async count() {
        await Promise.resolve();
        return users.size;
      },
      async claimFirstAdmin() {
        await Promise.resolve();
        if (firstAdminClaimed) return false;
        firstAdminClaimed = true;
        return true;
      },
    },

    refreshTokens: {
      async create(input) {
        await Promise.resolve();
        const record: RefreshTokenRecord = {
          id: newId(),
          ...input,
          revokedAt: null,
          replacedBy: null,
          reuseDetectedAt: null,
          createdAt: tick(),
        };
        tokens.set(record.id, record);
        return { ...record };
      },
      async findByHash(tokenHash) {
        await Promise.resolve();
        const record = [...tokens.values()].find((t) => t.tokenHash === tokenHash);
        return record ? { ...record } : null;
      },
      async revoke(id, at) {
        await Promise.resolve();
        const record = tokens.get(id);
        if (!record || record.revokedAt) return false;
        record.revokedAt = at;
        return true;
      },
      async setReplacedBy(id, replacedBy) {
        await Promise.resolve();
        const record = tokens.get(id);
        if (record) record.replacedBy = replacedBy;
      },
      async revokeFamily(familyId, at) {
        await Promise.resolve();
        for (const record of tokens.values()) {
          if (record.familyId !== familyId) continue;
          record.reuseDetectedAt = at;
          record.revokedAt ??= at;
        }
      },
      async isFamilyCompromised(familyId) {
        await Promise.resolve();
        return [...tokens.values()].some((t) => t.familyId === familyId && t.reuseDetectedAt);
      },
    },

    projects: {
      async create(input) {
        await Promise.resolve();
        const at = tick();
        const project: Project = {
          id: newId(),
          ...input,
          status: 'active',
          currentStep: 'sources',
          createdAt: at,
          updatedAt: at,
        };
        projects.set(project.id, project);
        return structuredClone(project);
      },
      async findById(id) {
        await Promise.resolve();
        return clone(projects.get(id));
      },
      async list(visibleTo, { skip, limit }) {
        await Promise.resolve();
        const visible = [...projects.values()]
          .filter(
            (p) =>
              visibleTo === null ||
              p.ownerId === visibleTo ||
              p.members.some((m) => m.userId === visibleTo),
          )
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
        return {
          items: visible.slice(skip, skip + limit).map((p) => structuredClone(p)),
          limit,
          total: visible.length,
        };
      },
      async update(id, patch) {
        await Promise.resolve();
        const project = projects.get(id);
        if (!project) return null;
        const defined = Object.entries(patch).filter(([, value]) => value !== undefined);
        Object.assign(project, Object.fromEntries(defined) as Partial<Project>);
        project.updatedAt = tick();
        return clone(project);
      },
      async delete(id) {
        await Promise.resolve();
        return projects.delete(id);
      },
      async addMember(id, member) {
        await Promise.resolve();
        const project = projects.get(id);
        if (!project || project.members.some((m) => m.userId === member.userId)) return null;
        project.members.push({ ...member });
        project.updatedAt = tick();
        return clone(project);
      },
      async removeMember(id, userId) {
        await Promise.resolve();
        const project = projects.get(id);
        if (!project) return null;
        project.members = project.members.filter((m) => m.userId !== userId);
        project.updatedAt = tick();
        return clone(project);
      },
    },

    audit: {
      async append(entry) {
        await Promise.resolve();
        const stored: AuditEntry = { id: newId(), ...structuredClone(entry), createdAt: tick() };
        audit.push(stored);
        return structuredClone(stored);
      },
      async listByProject(projectId, { skip, limit }) {
        await Promise.resolve();
        const entries = audit
          .filter((e) => e.projectId === projectId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return {
          items: entries.slice(skip, skip + limit).map((e) => structuredClone(e)),
          limit,
          total: entries.length,
        };
      },
    },
  };
}
