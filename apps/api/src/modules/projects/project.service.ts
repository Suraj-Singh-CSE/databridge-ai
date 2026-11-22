import { AppError } from '../../errors.js';
import type { Page } from '../../http.js';
import { toPageRequest } from '../../http.js';
import type { Repositories } from '../../repositories.js';
import { projectPrefix } from '../../storage/keys.js';
import type { FileStorage } from '../../storage/storage.types.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AuditEntry } from '../audit/audit.types.js';
import type { AccessClaims } from '../auth/tokens.js';

import type { Project, ProjectPatch, ProjectRole } from './project.types.js';

export interface Actor {
  user: AccessClaims;
  requestId: string;
}

export interface ProjectService {
  list(actor: Actor, page: number, limit: number): Promise<Page<Project>>;
  create(actor: Actor, input: { name: string; description: string }): Promise<Project>;
  update(actor: Actor, project: Project, patch: ProjectPatch): Promise<Project>;
  remove(actor: Actor, project: Project): Promise<void>;
  addMember(
    actor: Actor,
    project: Project,
    input: { email: string; role: ProjectRole },
  ): Promise<Project>;
  removeMember(actor: Actor, project: Project, userId: string): Promise<Project>;
  auditLog(project: Project, page: number, limit: number): Promise<Page<AuditEntry>>;
}

/** The fields worth keeping in an audit snapshot (no personal data). */
function snapshot(project: Project): Record<string, unknown> {
  return {
    name: project.name,
    description: project.description,
    status: project.status,
    currentStep: project.currentStep,
  };
}

const PROJECT_GONE = 'Project not found.';

export function createProjectService(
  repos: Pick<
    Repositories,
    | 'projects'
    | 'users'
    | 'sources'
    | 'columnProfiles'
    | 'jobs'
    | 'targetSchemas'
    | 'mappings'
    | 'stagedRecords'
    | 'candidates'
    | 'scores'
    | 'clusters'
    | 'review'
    | 'exports'
    | 'audit'
  >,
  audit: AuditService,
  storage: FileStorage,
): ProjectService {
  function record(
    actor: Actor,
    project: Project,
    action: string,
    entry: {
      entityType?: string;
      entityId?: string;
      before?: Record<string, unknown>;
      after?: Record<string, unknown>;
    },
  ): Promise<void> {
    return audit.record({
      projectId: project.id,
      actorId: actor.user.userId,
      action,
      entityType: entry.entityType ?? 'project',
      entityId: entry.entityId ?? project.id,
      before: entry.before ?? null,
      after: entry.after ?? null,
      requestId: actor.requestId,
    });
  }

  return {
    async list(actor, page, limit) {
      const visibleTo = actor.user.role === 'admin' ? null : actor.user.userId;
      const result = await repos.projects.list(visibleTo, toPageRequest(page, limit));
      return { ...result, page };
    },

    async create(actor, { name, description }) {
      const ownerId = actor.user.userId;
      const project = await repos.projects.create({
        name,
        description,
        ownerId,
        members: [{ userId: ownerId, role: 'data_engineer' }],
      });
      await record(actor, project, 'project.create', { after: snapshot(project) });
      return project;
    },

    async update(actor, project, patch) {
      const updated = await repos.projects.update(project.id, patch);
      if (!updated) throw AppError.notFound(PROJECT_GONE);
      await record(actor, updated, 'project.update', {
        before: snapshot(project),
        after: snapshot(updated),
      });
      return updated;
    },

    async remove(actor, project) {
      // Files, then source, profile, mapping, schema and job records, then the project: each step is idempotent, so
      // if one fails the project still exists and the owner can simply delete it again.
      await storage.deletePrefix(projectPrefix(project.id));
      await repos.columnProfiles.deleteByProject(project.id);
      await repos.mappings.deleteByProject(project.id);
      await repos.stagedRecords.deleteByProject(project.id);
      await repos.candidates.deleteByProject(project.id);
      await repos.scores.deleteByProject(project.id);
      await repos.clusters.deleteByProject(project.id);
      await repos.review.deleteByProject(project.id);
      await repos.exports.deleteByProject(project.id);
      await repos.targetSchemas.deleteByProject(project.id);
      await repos.sources.deleteByProject(project.id);
      await repos.jobs.deleteByProject(project.id);
      const deleted = await repos.projects.delete(project.id);
      if (!deleted) throw AppError.notFound(PROJECT_GONE);
      await record(actor, project, 'project.delete', { before: snapshot(project) });
    },

    async addMember(actor, project, { email, role }) {
      const user = await repos.users.findByEmail(email);
      if (!user) throw AppError.notFound('No user with this email exists.');
      if (project.ownerId === user.id || project.members.some((m) => m.userId === user.id)) {
        throw AppError.conflict('This user is already a member of the project.');
      }
      const updated = await repos.projects.addMember(project.id, { userId: user.id, role });
      if (!updated) throw AppError.conflict('This user is already a member of the project.');
      await record(actor, updated, 'project.member.add', {
        entityType: 'project_member',
        entityId: user.id,
        after: { userId: user.id, role },
      });
      return updated;
    },

    async removeMember(actor, project, userId) {
      if (userId === project.ownerId) {
        throw AppError.conflict('The project owner cannot be removed.');
      }
      const member = project.members.find((m) => m.userId === userId);
      if (!member) throw AppError.notFound('This user is not a member of the project.');
      const updated = await repos.projects.removeMember(project.id, userId);
      if (!updated) throw AppError.notFound(PROJECT_GONE);
      await record(actor, updated, 'project.member.remove', {
        entityType: 'project_member',
        entityId: userId,
        before: { userId, role: member.role },
      });
      return updated;
    },

    async auditLog(project, page, limit) {
      const result = await repos.audit.listByProject(project.id, toPageRequest(page, limit));
      return { ...result, page };
    },
  };
}
