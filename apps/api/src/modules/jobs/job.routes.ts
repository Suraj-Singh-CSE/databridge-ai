import { Router, type Request, type RequestHandler } from 'express';

import { AppError } from '../../errors.js';
import { sendData } from '../../http.js';
import { authenticate, currentUser } from '../../middleware/authenticate.js';
import { requestIdOf } from '../../middleware/request-id.js';
import {
  accessFor,
  currentProject,
  meetsMinimum,
  requireProjectAccess,
  type MinimumAccess,
} from '../../middleware/require-project-access.js';
import { validate, validated } from '../../middleware/validate.js';
import type { TokenService } from '../auth/tokens.js';
import type { Actor } from '../projects/project.service.js';
import type { ProjectRepository } from '../projects/project.types.js';

import type { JobEventBus } from './job.events.js';
import { createJobBody, jobParams, listJobsQuery, projectJobsParams } from './job.schemas.js';
import type { JobService } from './job.service.js';
import { streamJob } from './job.stream.js';
import type { Job, JobType } from './job.types.js';

export interface ProjectJobsRouterDeps {
  jobService: JobService;
  projects: ProjectRepository;
  tokens: TokenService;
}

export interface JobRouterDeps extends ProjectJobsRouterDeps {
  events: JobEventBus;
  keepAliveMs: number;
}

/** Starting and cancelling jobs: owner, admin or a data_engineer member. */
const WRITE: MinimumAccess = 'data_engineer';
/**
 * Job types data stewards may start too: an export of the customers they review (ADR 0020)
 * and a quality check of the final table (ADR 0022).
 */
const START: Partial<Record<JobType, MinimumAccess>> = {
  export: 'data_steward',
  quality: 'data_steward',
};

function actorOf(req: Request): Actor {
  return { user: currentUser(req), requestId: requestIdOf(req) };
}

function currentJob(req: Request): Job {
  if (!req.job) throw new Error('loadJob() must run before currentJob()');
  return req.job;
}

/** Mounted at /api/v1/projects/:projectId/jobs. */
export function createProjectJobsRouter({
  jobService,
  projects,
  tokens,
}: ProjectJobsRouterDeps): Router {
  const router = Router({ mergeParams: true });
  const access = (minimum: MinimumAccess) => requireProjectAccess(projects, minimum, 'projectId');

  router.use(authenticate(tokens));

  router.post(
    '/',
    validate({ params: projectJobsParams, body: createJobBody }),
    (req, res, next) => {
      const { type } = validated(req, 'body', createJobBody);
      return access(START[type] ?? WRITE)(req, res, next);
    },
    async (req, res) => {
      const input = validated(req, 'body', createJobBody);
      const job = await jobService.create(actorOf(req), currentProject(req), input);
      sendData(res, { job }, 202);
    },
  );

  router.get(
    '/',
    validate({ params: projectJobsParams, query: listJobsQuery }),
    access('viewer'),
    async (req, res) => {
      const { limit } = validated(req, 'query', listJobsQuery);
      sendData(res, { items: await jobService.listByProject(currentProject(req), limit) });
    },
  );

  return router;
}

/** Mounted at /api/v1/jobs. Access to a job = access to its project (non-members get 404). */
export function createJobRouter({
  jobService,
  projects,
  tokens,
  events,
  keepAliveMs,
}: JobRouterDeps): Router {
  const router = Router();

  const loadJob =
    (minimum: MinimumAccess): RequestHandler =>
    async (req, _res, next) => {
      const { jobId } = validated(req, 'params', jobParams);
      const user = currentUser(req);
      const job = await jobService.find(jobId);
      const project = job ? await projects.findById(job.projectId) : null;
      const access = project ? accessFor(project, user.userId, user.role === 'admin') : null;
      if (!job || !access) {
        next(AppError.notFound('Job not found.'));
        return;
      }
      if (!meetsMinimum(access, minimum)) {
        next(AppError.forbidden());
        return;
      }
      req.job = job;
      next();
    };

  router.use(authenticate(tokens));

  router.get('/:jobId', validate({ params: jobParams }), loadJob('viewer'), (req, res) => {
    sendData(res, { job: currentJob(req) });
  });

  router.post(
    '/:jobId/cancel',
    validate({ params: jobParams }),
    loadJob(WRITE),
    async (req, res) => {
      sendData(res, { job: await jobService.cancel(actorOf(req), currentJob(req)) });
    },
  );

  // Server-Sent Events. Authenticated with the usual Bearer header, so browsers read it with
  // fetch() streaming: EventSource cannot send an Authorization header.
  router.get(
    '/:jobId/events',
    validate({ params: jobParams }),
    loadJob('viewer'),
    async (req, res) => {
      const job = currentJob(req);
      await streamJob(res, job, {
        events,
        reload: () => jobService.find(job.id),
        keepAliveMs,
        logger: req.log,
      });
    },
  );

  return router;
}
