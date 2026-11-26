import { Router } from 'express';

import type { Logger } from '../../logger.js';
import { sendData } from '../../http.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requestIdOf } from '../../middleware/request-id.js';
import { currentProject, requireProjectAccess } from '../../middleware/require-project-access.js';
import { validate, validated } from '../../middleware/validate.js';
import type { TokenService } from '../auth/tokens.js';
import type { ProjectRepository } from '../projects/project.types.js';

import { dashboardParams, dashboardQuery } from './dashboard.schemas.js';
import type { DashboardService } from './dashboard.service.js';

export interface DashboardRouterDeps {
  dashboardService: DashboardService;
  projects: ProjectRepository;
  tokens: TokenService;
  logger: Logger;
}

/**
 * Mounted at /api/v1/projects/:projectId/dashboard (ADR 0023). Any member, viewers included,
 * may read it; non-members get 404. Counts, statuses and timings only, never record values.
 */
export function createDashboardRouter({
  dashboardService,
  projects,
  tokens,
  logger,
}: DashboardRouterDeps): Router {
  const router = Router({ mergeParams: true });
  const member = requireProjectAccess(projects, 'viewer', 'projectId');

  router.get(
    '/',
    authenticate(tokens),
    validate({ params: dashboardParams, query: dashboardQuery }),
    member,
    async (req, res) => {
      const { range } = validated(req, 'query', dashboardQuery);
      const started = performance.now();
      const dashboard = await dashboardService.get(currentProject(req), range, requestIdOf(req));
      const ms = Math.round(performance.now() - started);
      logger.info({ requestId: requestIdOf(req), range, ms }, 'dashboard built');
      sendData(res, dashboard);
    },
  );

  return router;
}
