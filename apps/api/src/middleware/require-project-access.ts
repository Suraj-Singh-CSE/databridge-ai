import type { Request, RequestHandler } from 'express';

import { AppError } from '../errors.js';
import type { Project, ProjectRepository, ProjectRole } from '../modules/projects/project.types.js';

import { currentUser } from './authenticate.js';

/** What a user may do in one project. `admin` is the global admin role. */
export type ProjectAccess = ProjectRole | 'owner' | 'admin';
export type MinimumAccess = ProjectRole | 'owner';

const RANK: Record<ProjectAccess, number> = {
  viewer: 1,
  data_steward: 2,
  data_engineer: 3,
  owner: 4,
  admin: 5,
};

const OBJECT_ID = /^[a-f\d]{24}$/i;

export function meetsMinimum(access: ProjectAccess, minimum: MinimumAccess): boolean {
  return RANK[access] >= RANK[minimum];
}

export function accessFor(
  project: Project,
  userId: string,
  isAdmin: boolean,
): ProjectAccess | null {
  if (isAdmin) return 'admin';
  if (project.ownerId === userId) return 'owner';
  return project.members.find((member) => member.userId === userId)?.role ?? null;
}

/**
 * Loads the project named by route param `param` (default `:id`) and checks the caller's access. Non-members get 404 (not 403) so project ids
 * cannot be probed; members below `minimum` get 403. Sets `req.project` and `req.projectAccess`.
 */
export function requireProjectAccess(
  projects: ProjectRepository,
  minimum: MinimumAccess,
  param = 'id',
): RequestHandler {
  return async (req, _res, next) => {
    const user = currentUser(req);
    const id = req.params[param];
    if (typeof id !== 'string' || !OBJECT_ID.test(id)) {
      next(
        AppError.validation('Some fields are invalid.', [
          { field: `params.${param}`, message: 'must be a valid id' },
        ]),
      );
      return;
    }
    const project = await projects.findById(id);
    const access = project ? accessFor(project, user.userId, user.role === 'admin') : null;
    if (!project || !access) {
      next(AppError.notFound('Project not found.'));
      return;
    }
    if (!meetsMinimum(access, minimum)) {
      next(AppError.forbidden());
      return;
    }
    req.project = project;
    req.projectAccess = access;
    next();
  };
}

/** The project loaded by `requireProjectAccess`. */
export function currentProject(req: Request): Project {
  if (!req.project) throw new Error('requireProjectAccess() must run before currentProject()');
  return req.project;
}
