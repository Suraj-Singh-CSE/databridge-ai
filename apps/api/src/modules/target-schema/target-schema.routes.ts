import { Router, type Request } from 'express';

import { sendData } from '../../http.js';
import { authenticate, currentUser } from '../../middleware/authenticate.js';
import { requestIdOf } from '../../middleware/request-id.js';
import { currentProject, requireProjectAccess } from '../../middleware/require-project-access.js';
import { validate, validated } from '../../middleware/validate.js';
import type { TokenService } from '../auth/tokens.js';
import type { Actor } from '../projects/project.service.js';
import type { ProjectRepository } from '../projects/project.types.js';

import { replaceTargetSchemaBody, targetSchemaParams } from './target-schema.schemas.js';
import { publicSchema, type TargetSchemaService } from './target-schema.service.js';

export interface TargetSchemaRouterDeps {
  targetSchemas: TargetSchemaService;
  projects: ProjectRepository;
  tokens: TokenService;
}

function actorOf(req: Request): Actor {
  return { user: currentUser(req), requestId: requestIdOf(req) };
}

/** Mounted at /api/v1/projects/:projectId/target-schema. */
export function createTargetSchemaRouter({
  targetSchemas,
  projects,
  tokens,
}: TargetSchemaRouterDeps): Router {
  const router = Router({ mergeParams: true });

  router.use(authenticate(tokens));

  router.get(
    '/',
    validate({ params: targetSchemaParams }),
    requireProjectAccess(projects, 'viewer', 'projectId'),
    async (req, res) => {
      sendData(res, { schema: publicSchema(await targetSchemas.current(currentProject(req))) });
    },
  );

  // Owner, admin or a data_engineer member, like starting jobs.
  router.put(
    '/',
    validate({ params: targetSchemaParams, body: replaceTargetSchemaBody }),
    requireProjectAccess(projects, 'data_engineer', 'projectId'),
    async (req, res) => {
      const input = validated(req, 'body', replaceTargetSchemaBody);
      const schema = await targetSchemas.replace(actorOf(req), currentProject(req), input);
      sendData(res, { schema: publicSchema(schema) });
    },
  );

  return router;
}
