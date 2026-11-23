import { Router, type Request } from 'express';

import { sendData } from '../../http.js';
import { authenticate, currentUser } from '../../middleware/authenticate.js';
import { requestIdOf } from '../../middleware/request-id.js';
import { currentProject, requireProjectAccess } from '../../middleware/require-project-access.js';
import { validate, validated } from '../../middleware/validate.js';
import type { TokenService } from '../auth/tokens.js';
import type { Actor } from '../projects/project.service.js';
import type { ProjectRepository } from '../projects/project.types.js';

import {
  listQualityRunsQuery,
  putQualityRulesBody,
  qualityParams,
  qualityRunParams,
} from './quality.schemas.js';
import type { QualityService } from './quality.service.js';

export interface QualityRouterDeps {
  qualityService: QualityService;
  projects: ProjectRepository;
  tokens: TokenService;
}

function actorOf(req: Request): Actor {
  return { user: currentUser(req), requestId: requestIdOf(req) };
}

/**
 * Mounted at /api/v1/projects/:projectId/quality (ADR 0022). Reports are written by `quality`
 * jobs (POST .../jobs). Any member may read reports and rule settings; owner, admin and data
 * engineers change the thresholds (audited).
 */
export function createQualityRouter({
  qualityService,
  projects,
  tokens,
}: QualityRouterDeps): Router {
  const router = Router({ mergeParams: true });
  const member = requireProjectAccess(projects, 'viewer', 'projectId');
  const engineer = requireProjectAccess(projects, 'data_engineer', 'projectId');

  router.use(authenticate(tokens));

  router.get(
    '/runs',
    validate({ params: qualityParams, query: listQualityRunsQuery }),
    member,
    async (req, res) => {
      const { page, limit } = validated(req, 'query', listQualityRunsQuery);
      sendData(res, await qualityService.listRuns(currentProject(req), page, limit));
    },
  );

  router.get('/runs/:runId', validate({ params: qualityRunParams }), member, async (req, res) => {
    const { runId } = validated(req, 'params', qualityRunParams);
    sendData(res, { run: await qualityService.getRun(currentProject(req), runId) });
  });

  router.get('/latest', validate({ params: qualityParams }), member, async (req, res) => {
    sendData(res, { run: await qualityService.latest(currentProject(req)) });
  });

  router.get('/rules', validate({ params: qualityParams }), member, async (req, res) => {
    sendData(res, { rules: await qualityService.rules(currentProject(req)) });
  });

  router.put(
    '/rules',
    validate({ params: qualityParams, body: putQualityRulesBody }),
    engineer,
    async (req, res) => {
      const body = validated(req, 'body', putQualityRulesBody);
      const rules = await qualityService.saveRules(actorOf(req), currentProject(req), body);
      sendData(res, { rules });
    },
  );

  return router;
}
