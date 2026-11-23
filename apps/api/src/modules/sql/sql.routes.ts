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
  approveSqlBody,
  listSqlVersionsQuery,
  rejectSqlBody,
  sqlVersionParams,
  sqlVersionsParams,
} from './sql.schemas.js';
import type { SqlService } from './sql.service.js';

export interface SqlRouterDeps {
  sqlService: SqlService;
  projects: ProjectRepository;
  tokens: TokenService;
}

function actorOf(req: Request): Actor {
  return { user: currentUser(req), requestId: requestIdOf(req) };
}

/**
 * Mounted at /api/v1/projects/:projectId/sql (ADR 0021). Versions are drafted by `sql_draft`
 * jobs and run by `sql_run` jobs (POST .../jobs). Any member may read them; owner, admin and
 * data engineers approve or reject. Every decision is audited.
 */
export function createSqlRouter({ sqlService, projects, tokens }: SqlRouterDeps): Router {
  const router = Router({ mergeParams: true });
  const member = requireProjectAccess(projects, 'viewer', 'projectId');
  const engineer = requireProjectAccess(projects, 'data_engineer', 'projectId');

  router.use(authenticate(tokens));

  router.get(
    '/versions',
    validate({ params: sqlVersionsParams, query: listSqlVersionsQuery }),
    member,
    async (req, res) => {
      const { limit } = validated(req, 'query', listSqlVersionsQuery);
      sendData(res, { items: await sqlService.list(currentProject(req), limit) });
    },
  );

  router.get(
    '/versions/:versionId',
    validate({ params: sqlVersionParams }),
    member,
    async (req, res) => {
      const { versionId } = validated(req, 'params', sqlVersionParams);
      sendData(res, { version: await sqlService.get(currentProject(req), versionId) });
    },
  );

  router.post(
    '/versions/:versionId/approve',
    validate({ params: sqlVersionParams, body: approveSqlBody }),
    engineer,
    async (req, res) => {
      const { versionId } = validated(req, 'params', sqlVersionParams);
      const version = await sqlService.approve(actorOf(req), currentProject(req), versionId);
      sendData(res, { version });
    },
  );

  router.post(
    '/versions/:versionId/reject',
    validate({ params: sqlVersionParams, body: rejectSqlBody }),
    engineer,
    async (req, res) => {
      const { versionId } = validated(req, 'params', sqlVersionParams);
      const { reason } = validated(req, 'body', rejectSqlBody);
      const version = await sqlService.reject(
        actorOf(req),
        currentProject(req),
        versionId,
        reason ?? null,
      );
      sendData(res, { version });
    },
  );

  return router;
}
