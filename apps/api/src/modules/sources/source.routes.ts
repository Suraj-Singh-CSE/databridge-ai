import { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';

import { AppError } from '../../errors.js';
import { sendData } from '../../http.js';
import { authenticate, currentUser } from '../../middleware/authenticate.js';
import { requestIdOf } from '../../middleware/request-id.js';
import { currentProject, requireProjectAccess } from '../../middleware/require-project-access.js';
import { validate, validated } from '../../middleware/validate.js';
import type { TokenService } from '../auth/tokens.js';
import type { Actor } from '../projects/project.service.js';
import type { ProjectRepository } from '../projects/project.types.js';

import {
  previewQuery,
  projectSourcesParams,
  sourceParams,
  updateSourceBody,
} from './source.schemas.js';
import { publicSource, type SourceService } from './source.service.js';

export interface SourceRouterDeps {
  sourceService: SourceService;
  projects: ProjectRepository;
  tokens: TokenService;
  uploadRateLimit: { max: number; windowMs: number };
}

function actorOf(req: Request): Actor {
  return { user: currentUser(req), requestId: requestIdOf(req) };
}

/** Mounted at /api/v1/projects/:projectId/sources. */
export function createSourceRouter({
  sourceService,
  projects,
  tokens,
  uploadRateLimit,
}: SourceRouterDeps): Router {
  const router = Router({ mergeParams: true });
  const access = (minimum: Parameters<typeof requireProjectAccess>[1]) =>
    requireProjectAccess(projects, minimum, 'projectId');

  // Per user, not per IP: everyone behind one office proxy should not share a budget.
  const uploadLimiter = rateLimit({
    windowMs: uploadRateLimit.windowMs,
    limit: uploadRateLimit.max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => currentUser(req).userId,
    handler: (_req, _res, next) => {
      next(
        new AppError(
          429,
          'RATE_LIMITED',
          'You have uploaded many files recently. Please wait and try again.',
        ),
      );
    },
  });

  router.use(authenticate(tokens));

  router.get(
    '/',
    validate({ params: projectSourcesParams }),
    access('viewer'),
    async (req, res) => {
      const sources = await sourceService.list(currentProject(req));
      sendData(res, { items: sources.map(publicSource) });
    },
  );

  router.post(
    '/',
    validate({ params: projectSourcesParams }),
    access('data_engineer'),
    uploadLimiter,
    async (req, res) => {
      try {
        const source = await sourceService.upload(actorOf(req), currentProject(req), req);
        sendData(res, { source: publicSource(source) }, 201);
      } catch (error) {
        // The body may still be arriving: answer now and close instead of reading the rest.
        if (!req.complete) {
          res.setHeader('Connection', 'close');
          req.resume();
        }
        throw error;
      }
    },
  );

  router.get(
    '/:sourceId',
    validate({ params: sourceParams }),
    access('viewer'),
    async (req, res) => {
      const { sourceId } = validated(req, 'params', sourceParams);
      const source = await sourceService.get(currentProject(req), sourceId);
      sendData(res, { source: publicSource(source) });
    },
  );

  router.patch(
    '/:sourceId',
    validate({ params: sourceParams, body: updateSourceBody }),
    access('data_engineer'),
    async (req, res) => {
      const { sourceId } = validated(req, 'params', sourceParams);
      const patch = validated(req, 'body', updateSourceBody);
      const source = await sourceService.update(actorOf(req), currentProject(req), sourceId, patch);
      sendData(res, { source: publicSource(source) });
    },
  );

  router.delete(
    '/:sourceId',
    validate({ params: sourceParams }),
    access('data_engineer'),
    async (req, res) => {
      const { sourceId } = validated(req, 'params', sourceParams);
      await sourceService.remove(actorOf(req), currentProject(req), sourceId);
      res.status(204).end();
    },
  );

  router.get(
    '/:sourceId/preview',
    validate({ params: sourceParams, query: previewQuery }),
    access('viewer'),
    async (req, res) => {
      const { sourceId } = validated(req, 'params', sourceParams);
      const { limit } = validated(req, 'query', previewQuery);
      sendData(res, await sourceService.preview(currentProject(req), sourceId, limit));
    },
  );

  return router;
}
