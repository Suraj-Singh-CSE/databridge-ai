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
  clusterDetailParams,
  clusterDetailQuery,
  clusterParams,
  clusterQuery,
  clusterSummaryQuery,
  emptyBody,
  mergeBody,
  splitBody,
} from './cluster.schemas.js';
import type { ClusterService } from './cluster.service.js';
import type { ReviewService } from './review.service.js';

export interface ClusterRouterDeps {
  clusterService: ClusterService;
  reviewService: ReviewService;
  projects: ProjectRepository;
  tokens: TokenService;
}

function actorOf(req: Request): Actor {
  return { user: currentUser(req), requestId: requestIdOf(req) };
}

/**
 * Mounted at /api/v1/projects/:projectId/clusters. Any member may read: like candidate pairs
 * and scores, a cluster shows its records' standardised fields. Clusters and golden records
 * are proposals made by the `clustering` job; data stewards and up (owner, admin,
 * data_engineer) decide on them: approve, split a record out, merge two (ADR 0019).
 */
export function createClusterRouter({
  clusterService,
  reviewService,
  projects,
  tokens,
}: ClusterRouterDeps): Router {
  const router = Router({ mergeParams: true });
  const member = requireProjectAccess(projects, 'viewer', 'projectId');
  const reviewer = requireProjectAccess(projects, 'data_steward', 'projectId');

  router.use(authenticate(tokens));

  // Before '/:customerId' so these paths are not read as customer ids.
  router.post(
    '/approve-high',
    validate({ params: clusterParams, body: emptyBody }),
    reviewer,
    async (req, res) => {
      sendData(res, await reviewService.approveHigh(actorOf(req), currentProject(req)));
    },
  );

  router.post(
    '/merge',
    validate({ params: clusterParams, body: mergeBody }),
    reviewer,
    async (req, res) => {
      const body = validated(req, 'body', mergeBody);
      sendData(res, await reviewService.merge(actorOf(req), currentProject(req), body));
    },
  );

  router.post(
    '/:customerId/approve',
    validate({ params: clusterDetailParams, body: emptyBody }),
    reviewer,
    async (req, res) => {
      const { customerId } = validated(req, 'params', clusterDetailParams);
      sendData(res, await reviewService.approve(actorOf(req), currentProject(req), customerId));
    },
  );

  router.delete(
    '/:customerId/approval',
    validate({ params: clusterDetailParams }),
    reviewer,
    async (req, res) => {
      const { customerId } = validated(req, 'params', clusterDetailParams);
      sendData(res, await reviewService.unapprove(actorOf(req), currentProject(req), customerId));
    },
  );

  router.post(
    '/:customerId/split',
    validate({ params: clusterDetailParams, body: splitBody }),
    reviewer,
    async (req, res) => {
      const { customerId } = validated(req, 'params', clusterDetailParams);
      const body = validated(req, 'body', splitBody);
      sendData(res, await reviewService.split(actorOf(req), currentProject(req), customerId, body));
    },
  );

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
