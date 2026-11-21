import { Router, type Request } from 'express';

import { sendData } from '../../http.js';
import { authenticate, currentUser } from '../../middleware/authenticate.js';
import { requestIdOf } from '../../middleware/request-id.js';
import {
  currentProject,
  requireProjectAccess,
  type MinimumAccess,
} from '../../middleware/require-project-access.js';
import { validate, validated } from '../../middleware/validate.js';
import type { TokenService } from '../auth/tokens.js';
import type { Actor } from '../projects/project.service.js';
import type { ProjectRepository } from '../projects/project.types.js';

import { columnParams, decideBody, mappingsParams } from './mapping.schemas.js';
import type { MappingService } from './mapping.service.js';

export interface MappingRouterDeps {
  mappingService: MappingService;
  projects: ProjectRepository;
  tokens: TokenService;
}

/** Reviewing suggestions: data stewards and up (owner, admin, data_engineer); viewers only read. */
const REVIEW: MinimumAccess = 'data_steward';

function actorOf(req: Request): Actor {
  return { user: currentUser(req), requestId: requestIdOf(req) };
}

/** Mounted at /api/v1/projects/:projectId/sources/:sourceId/mappings. */
export function createMappingRouter({
  mappingService,
  projects,
  tokens,
}: MappingRouterDeps): Router {
  const router = Router({ mergeParams: true });
  const access = (minimum: MinimumAccess) => requireProjectAccess(projects, minimum, 'projectId');

  router.use(authenticate(tokens));

  router.get('/', validate({ params: mappingsParams }), access('viewer'), async (req, res) => {
    const { sourceId } = validated(req, 'params', mappingsParams);
    sendData(res, await mappingService.list(currentProject(req), sourceId));
  });

  router.post(
    '/accept-high',
    validate({ params: mappingsParams }),
    access(REVIEW),
    async (req, res) => {
      const { sourceId } = validated(req, 'params', mappingsParams);
      sendData(res, await mappingService.acceptHigh(actorOf(req), currentProject(req), sourceId));
    },
  );

  router.patch(
    '/:column',
    validate({ params: columnParams, body: decideBody }),
    access(REVIEW),
    async (req, res) => {
      const { sourceId, column } = validated(req, 'params', columnParams);
      const body = validated(req, 'body', decideBody);
      const mapping = await mappingService.decide(
        actorOf(req),
        currentProject(req),
        sourceId,
        column,
        body,
      );
      sendData(res, { column: mapping });
    },
  );

  return router;
}
