import { Router, type Request } from 'express';

import { sendData } from '../../http.js';
import { authenticate, currentUser } from '../../middleware/authenticate.js';
import { requestIdOf } from '../../middleware/request-id.js';
import { currentProject, requireProjectAccess } from '../../middleware/require-project-access.js';
import { requireRole } from '../../middleware/require-role.js';
import { validate, validated } from '../../middleware/validate.js';
import type { ProjectRepository } from './project.types.js';
import type { TokenService } from '../auth/tokens.js';

import {
  addMemberBody,
  createProjectBody,
  memberParams,
  pageQuery,
  projectIdParams,
  updateProjectBody,
} from './project.schemas.js';
import type { Actor, ProjectService } from './project.service.js';

export interface ProjectRouterDeps {
  projectService: ProjectService;
  projects: ProjectRepository;
  tokens: TokenService;
}

function actorOf(req: Request): Actor {
  return { user: currentUser(req), requestId: requestIdOf(req) };
}

export function createProjectRouter({
  projectService,
  projects,
  tokens,
}: ProjectRouterDeps): Router {
  const router = Router();
  const access = (minimum: Parameters<typeof requireProjectAccess>[1]) =>
    requireProjectAccess(projects, minimum);

  router.use(authenticate(tokens));

  router.get('/', validate({ query: pageQuery }), async (req, res) => {
    const { page, limit } = validated(req, 'query', pageQuery);
    sendData(res, await projectService.list(actorOf(req), page, limit));
  });

  router.post(
    '/',
    requireRole('admin', 'data_engineer'),
    validate({ body: createProjectBody }),
    async (req, res) => {
      const input = validated(req, 'body', createProjectBody);
      sendData(res, { project: await projectService.create(actorOf(req), input) }, 201);
    },
  );

  router.get('/:id', validate({ params: projectIdParams }), access('viewer'), (req, res) => {
    sendData(res, { project: currentProject(req) });
  });

  router.patch(
    '/:id',
    validate({ params: projectIdParams, body: updateProjectBody }),
    access('data_engineer'),
    async (req, res) => {
      const patch = validated(req, 'body', updateProjectBody);
      const project = await projectService.update(actorOf(req), currentProject(req), patch);
      sendData(res, { project });
    },
  );

  router.delete(
    '/:id',
    validate({ params: projectIdParams }),
    access('owner'),
    async (req, res) => {
      await projectService.remove(actorOf(req), currentProject(req));
      res.status(204).end();
    },
  );

  router.post(
    '/:id/members',
    validate({ params: projectIdParams, body: addMemberBody }),
    access('owner'),
    async (req, res) => {
      const input = validated(req, 'body', addMemberBody);
      const project = await projectService.addMember(actorOf(req), currentProject(req), input);
      sendData(res, { project }, 201);
    },
  );

  router.delete(
    '/:id/members/:userId',
    validate({ params: memberParams }),
    access('owner'),
    async (req, res) => {
      const { userId } = validated(req, 'params', memberParams);
      const project = await projectService.removeMember(actorOf(req), currentProject(req), userId);
      sendData(res, { project });
    },
  );

  router.get(
    '/:id/people',
    validate({ params: projectIdParams }),
    access('viewer'),
    async (req, res) => {
      sendData(res, { people: await projectService.people(currentProject(req)) });
    },
  );

  router.get(
    '/:id/audit',
    validate({ params: projectIdParams, query: pageQuery }),
    access('viewer'),
    async (req, res) => {
      const { page, limit } = validated(req, 'query', pageQuery);
      sendData(res, await projectService.auditLog(currentProject(req), page, limit));
    },
  );

  return router;
}
