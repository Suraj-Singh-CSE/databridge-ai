import { Router } from 'express';

import { sendData } from '../../http.js';
import { authenticate } from '../../middleware/authenticate.js';
import { currentProject, requireProjectAccess } from '../../middleware/require-project-access.js';
import { validate, validated } from '../../middleware/validate.js';
import type { TokenService } from '../auth/tokens.js';
import type { ProjectRepository } from '../projects/project.types.js';

import { scoreParams, scoreQuery, scoreSummaryQuery } from './score.schemas.js';
import type { ScoreService } from './score.service.js';

export interface ScoreRouterDeps {
  scoreService: ScoreService;
  projects: ProjectRepository;
  tokens: TokenService;
}

/**
 * Mounted at /api/v1/projects/:projectId/scores. Any member may read: like candidate pairs,
 * each score shows both records side by side. Scores are made by the `scoring` job.
 */
export function createScoreRouter({ scoreService, projects, tokens }: ScoreRouterDeps): Router {
  const router = Router({ mergeParams: true });
  const member = requireProjectAccess(projects, 'viewer', 'projectId');

  router.use(authenticate(tokens));

  router.get(
    '/summary',
    validate({ params: scoreParams, query: scoreSummaryQuery }),
    member,
    async (req, res) => {
      sendData(res, await scoreService.summary(currentProject(req)));
    },
  );

  router.get(
    '/',
    validate({ params: scoreParams, query: scoreQuery }),
    member,
    async (req, res) => {
      const query = validated(req, 'query', scoreQuery);
      sendData(res, await scoreService.list(currentProject(req), query));
    },
  );

  return router;
}
