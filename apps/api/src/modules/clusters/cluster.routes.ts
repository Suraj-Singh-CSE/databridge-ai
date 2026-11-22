import { Router } from 'express';

import { sendData } from '../../http.js';
import { authenticate } from '../../middleware/authenticate.js';
import { currentProject, requireProjectAccess } from '../../middleware/require-project-access.js';
import { validate, validated } from '../../middleware/validate.js';
import type { TokenService } from '../auth/tokens.js';
import type { ProjectRepository } from '../projects/project.types.js';

import {
  clusterDetailParams,
  clusterDetailQuery,
  clusterParams,
  clusterQuery,
  clusterSummaryQuery,
} from './cluster.schemas.js';
import type { ClusterService } from './cluster.service.js';

export interface ClusterRouterDeps {
  clusterService: ClusterService;
  projects: ProjectRepository;
  tokens: TokenService;
}

/**
 * Mounted at /api/v1/projects/:projectId/clusters. Any member may read: like candidate pairs
 * and scores, a cluster shows its records' standardised fields. Clusters and golden records
 * are proposals made by the `clustering` job.
 */
export function createClusterRouter({
  clusterService,
  projects,
  tokens,
}: ClusterRouterDeps): Router {
  const router = Router({ mergeParams: true });
  const member = requireProjectAccess(projects, 'viewer', 'projectId');

  router.use(authenticate(tokens));

  router.get(
    '/summary',
    validate({ params: clusterParams, query: clusterSummaryQuery }),
    member,
    async (req, res) => {
      sendData(res, await clusterService.summary(currentProject(req)));
    },
  );

  router.get(
    '/',
    validate({ params: clusterParams, query: clusterQuery }),
    member,
    async (req, res) => {
      const query = validated(req, 'query', clusterQuery);
      sendData(res, await clusterService.list(currentProject(req), query));
    },
  );

  router.get(
    '/:customerId',
    validate({ params: clusterDetailParams, query: clusterDetailQuery }),
    member,
    async (req, res) => {
      const { customerId } = validated(req, 'params', clusterDetailParams);
      sendData(res, await clusterService.get(currentProject(req), customerId));
    },
  );

  return router;
}
