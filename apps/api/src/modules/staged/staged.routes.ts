import { Router } from 'express';

import { sendData } from '../../http.js';
import { authenticate } from '../../middleware/authenticate.js';
import { currentProject, requireProjectAccess } from '../../middleware/require-project-access.js';
import { validate, validated } from '../../middleware/validate.js';
import type { TokenService } from '../auth/tokens.js';
import type { ProjectRepository } from '../projects/project.types.js';

import { stagedParams, stagedQuery } from './staged.schemas.js';
import type { StagedService } from './staged.service.js';

export interface StagedRouterDeps {
  stagedService: StagedService;
  projects: ProjectRepository;
  tokens: TokenService;
}

/**
 * Mounted at /api/v1/projects/:projectId/sources/:sourceId/staged. Any member may read: values
 * are returned as stored, like the file preview (members may see their project's data).
 */
export function createStagedRouter({ stagedService, projects, tokens }: StagedRouterDeps): Router {
  const router = Router({ mergeParams: true });

  router.use(authenticate(tokens));

  router.get(
    '/',
    validate({ params: stagedParams, query: stagedQuery }),
    requireProjectAccess(projects, 'viewer', 'projectId'),
    async (req, res) => {
      const { sourceId } = validated(req, 'params', stagedParams);
      const query = validated(req, 'query', stagedQuery);
      sendData(res, await stagedService.list(currentProject(req), sourceId, query));
    },
  );

  return router;
}
