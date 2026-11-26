import { AppError } from '../../errors.js';
import { isDuplicateKeyError } from '../../mongo-errors.js';
import type { Repositories } from '../../repositories.js';
import type { AuditService } from '../audit/audit.service.js';
import type { Actor } from '../projects/project.service.js';
import type { Project } from '../projects/project.types.js';

import type { SqlVersion } from './sql.types.js';

/** What a list shows of a version: everything but the query text and the attempt log. */
export type SqlVersionSummary = Omit<SqlVersion, 'sql' | 'attempts'>;

export interface SqlService {
  list(project: Project, limit: number): Promise<SqlVersionSummary[]>;
  get(project: Project, versionId: string): Promise<SqlVersion>;
  /** Only a draft whose tests all passed (409 otherwise); supersedes the approved one. */
  approve(actor: Actor, project: Project, versionId: string): Promise<SqlVersion>;
  reject(
    actor: Actor,
    project: Project,
    versionId: string,
    reason: string | null,
  ): Promise<SqlVersion>;
}

export const SQL_VERSION_NOT_FOUND = 'SQL version not found.';
export const SQL_MESSAGES = {
  testsFailed: (failed: string[]) =>
    `This version failed its automatic tests${failed.length ? ` (${failed.join(', ')})` : ''}, ` +
    'so it cannot be approved. Draft a new version.',
  notDraft: (status: string) => `Only a draft can be approved; this version is ${status}.`,
  decided: (status: string) => `This version is already ${status}.`,
  concurrent: 'Someone else approved another version at the same time — refresh and try again.',
};

type SqlRepos = Pick<Repositories, 'sqlVersions'>;

function failedChecks(version: SqlVersion): string[] {
  return (version.tests?.checks ?? []).filter((c) => c.status === 'failed').map((c) => c.name);
}

export function createSqlService(
  repos: SqlRepos,
  audit: AuditService,
  now: () => Date = () => new Date(),
): SqlService {
  async function find(project: Project, versionId: string): Promise<SqlVersion> {
    const version = await repos.sqlVersions.findById(project.id, versionId);
    if (!version) throw AppError.notFound(SQL_VERSION_NOT_FOUND);
    return version;
  }

  const snapshot = (v: SqlVersion) => ({
    version: v.version,
    status: v.status,
    method: v.method,
    testsPassed: v.testsPassed,
    clusteringRunId: v.clusteringRunId,
  });

  return {
    async list(project, limit) {
      const versions = await repos.sqlVersions.listByProject(project.id, limit);
      return versions.map(({ sql: _sql, attempts: _attempts, ...rest }) => rest);
    },

    get: find,

    async approve(actor, project, versionId) {
      const version = await find(project, versionId);
      if (version.status !== 'draft') {
        throw AppError.conflict(SQL_MESSAGES.notDraft(version.status), {
          reason: 'SQL_VERSION_NOT_DRAFT',
        });
      }
      if (!version.testsPassed) {
        throw AppError.conflict(SQL_MESSAGES.testsFailed(failedChecks(version)), {
          reason: 'SQL_TESTS_FAILED',
          failedChecks: failedChecks(version),
        });
      }
      let result;
      try {
        result = await repos.sqlVersions.approve(project.id, version.id, actor.user.userId, now());
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        throw AppError.conflict(SQL_MESSAGES.concurrent, { reason: 'SQL_APPROVE_CONFLICT' });
      }
      if (!result) {
        // Decided by someone else between the read and the write.
        const latest = await find(project, versionId);
        throw AppError.conflict(SQL_MESSAGES.notDraft(latest.status), {
          reason: 'SQL_VERSION_NOT_DRAFT',
        });
      }
      await audit.record({
        projectId: project.id,
        actorId: actor.user.userId,
        action: 'sql_version.approve',
        entityType: 'sql_version',
        entityId: version.id,
        before: snapshot(version),
        after: { ...snapshot(result.version), supersededVersions: result.superseded },
        requestId: actor.requestId,
      });
      return result.version;
    },

    async reject(actor, project, versionId, reason) {
      const version = await find(project, versionId);
      if (version.status !== 'draft' && version.status !== 'approved') {
        throw AppError.conflict(SQL_MESSAGES.decided(version.status), {
          reason: 'SQL_VERSION_DECIDED',
        });
      }
      const rejected = await repos.sqlVersions.reject(
        project.id,
        version.id,
        actor.user.userId,
        now(),
        reason,
      );
      if (!rejected) {
        const latest = await find(project, versionId);
        throw AppError.conflict(SQL_MESSAGES.decided(latest.status), {
          reason: 'SQL_VERSION_DECIDED',
        });
      }
      await audit.record({
        projectId: project.id,
        actorId: actor.user.userId,
        action: 'sql_version.reject',
        entityType: 'sql_version',
        entityId: version.id,
        before: snapshot(version),
        after: { ...snapshot(rejected), reason },
        requestId: actor.requestId,
      });
      return rejected;
    },
  };
}
