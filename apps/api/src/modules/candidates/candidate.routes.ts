import { Router } from 'express';

import { sendData } from '../../http.js';
import { authenticate } from '../../middleware/authenticate.js';
import { currentProject, requireProjectAccess } from '../../middleware/require-project-access.js';
import { validate, validated } from '../../middleware/validate.js';
import type { TokenService } from '../auth/tokens.js';
import type { ProjectRepository } from '../projects/project.types.js';

import { candidateParams, candidateQuery, summaryQuery } from './candidate.schemas.js';
import type { CandidateService } from './candidate.service.js';

export interface CandidateRouterDeps {
  candidateService: CandidateService;
  projects: ProjectRepository;
  tokens: TokenService;
}

/**
 * Mounted at /api/v1/projects/:projectId/candidates. Any member may read: the pairs show both
 * records' standardised values side by side, like the staged rows (members see their data).
 * The pairs are made by the `candidates` job (POST .../jobs).
 */
export function createCandidateRouter({
  candidateService,
  projects,
  tokens,
}: CandidateRouterDeps): Router {
  const router = Router({ mergeParams: true });
  const member = requireProjectAccess(projects, 'viewer', 'projectId');

  router.use(authenticate(tokens));

  router.get(
    '/summary',
    validate({ params: candidateParams, query: summaryQuery }),
    member,
    async (req, res) => {
      sendData(res, await candidateService.summary(currentProject(req)));
    },
  );

  router.get(
    '/',
    validate({ params: candidateParams, query: candidateQuery }),
    member,
    async (req, res) => {
      const query = validated(req, 'query', candidateQuery);
      sendData(res, await candidateService.list(currentProject(req), query));
    },
  );

  return router;
}
