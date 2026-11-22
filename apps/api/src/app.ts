import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';

import { createAiServiceClient, type AiServiceClient } from './ai-service.client.js';
import type { Config } from './config.js';
import { AppError } from './errors.js';
import type { Logger } from './logger.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { requestLogger } from './middleware/request-id.js';
import { createAuditService } from './modules/audit/audit.service.js';
import { AUTH_BASE_PATH } from './modules/auth/auth.cookie.js';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import { createAuthService } from './modules/auth/auth.service.js';
import { createPasswordHasher, type PasswordHasher } from './modules/auth/password.js';
import { createTokenService } from './modules/auth/tokens.js';
import type { JobEventBus } from './modules/jobs/job.events.js';
import { createJobRouter, createProjectJobsRouter } from './modules/jobs/job.routes.js';
import { createJobService } from './modules/jobs/job.service.js';
import { createMappingRouter } from './modules/mappings/mapping.routes.js';
import { createMappingService } from './modules/mappings/mapping.service.js';
import { createStagedRouter } from './modules/staged/staged.routes.js';
import { createStagedService } from './modules/staged/staged.service.js';
import { createProjectRouter } from './modules/projects/project.routes.js';
import { createProjectService } from './modules/projects/project.service.js';
import { createSourceRouter } from './modules/sources/source.routes.js';
import { createSourceService } from './modules/sources/source.service.js';
import { createTargetSchemaRouter } from './modules/target-schema/target-schema.routes.js';
import { createTargetSchemaService } from './modules/target-schema/target-schema.service.js';
import type { Repositories } from './repositories.js';
import { createStorage, type FileStorage } from './storage/index.js';

export interface AppDeps {
  config: Config;
  logger: Logger;
  repos: Repositories;
  /** Defaults to bcrypt cost 12. Tests inject a cheaper cost to stay fast. */
  passwords?: PasswordHasher;
  /** Defaults to the driver selected by STORAGE_DRIVER. Tests inject a temp-dir storage. */
  storage?: FileStorage;
  /** Live job updates (Redis pub/sub in production, in-memory in tests). */
  jobEvents: JobEventBus;
  /** Defaults to the HTTP client for AI_SERVICE_URL. Tests inject a fake. */
  aiService?: AiServiceClient;
}

export function createApp({
  config,
  logger,
  repos,
  passwords,
  storage,
  jobEvents,
  aiService,
}: AppDeps): Express {
  const files = storage ?? createStorage(config);
  const tokens = createTokenService(config);
  const audit = createAuditService(repos.audit);
  const auth = createAuthService({
    repos,
    tokens,
    passwords: passwords ?? createPasswordHasher(),
    audit,
    logger,
  });
  const projectService = createProjectService(repos, audit, files);
  const sourceService = createSourceService(repos, files, audit, {
    maxUploadBytes: config.MAX_UPLOAD_BYTES,
    maxUploadRows: config.MAX_UPLOAD_ROWS,
    maxSourcesPerProject: config.MAX_SOURCES_PER_PROJECT,
    xlsx: {
      maxUncompressedBytes: config.XLSX_MAX_UNCOMPRESSED_BYTES,
      maxCompressionRatio: config.XLSX_MAX_COMPRESSION_RATIO,
    },
  });
  const targetSchemas = createTargetSchemaService(repos.targetSchemas, audit);
  const mappingService = createMappingService(repos, targetSchemas, audit);
  const stagedService = createStagedService(repos);
  const jobService = createJobService({
    repos,
    targetSchemas,
    audit,
    events: jobEvents,
    aiService: aiService ?? createAiServiceClient(config),
    logger,
    staleAfterMs: config.JOB_STALE_AFTER_SECONDS * 1000,
  });
  const jobDeps = {
    jobService,
    projects: repos.projects,
    tokens,
    events: jobEvents,
    keepAliveMs: config.JOB_EVENTS_KEEPALIVE_MS,
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY);

  app.use(requestLogger(logger));
  app.use(helmet());
  app.use(cors({ origin: config.CORS_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.get('/api/v1/health', (_req, res) => {
    res.json({ data: { status: 'ok', service: 'api' }, error: null });
  });

  const authLimiter = rateLimit({
    windowMs: config.AUTH_RATE_LIMIT_WINDOW_MS,
    limit: config.AUTH_RATE_LIMIT_MAX,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => {
      next(new AppError(429, 'RATE_LIMITED', 'Too many attempts. Please wait and try again.'));
    },
  });
  app.use(
    AUTH_BASE_PATH,
    authLimiter,
    createAuthRouter({ auth, tokens, secureCookies: config.NODE_ENV === 'production' }),
  );
  // Before the project router so its '/:id' routes and auth do not run for source/job paths first.
  app.use(
    '/api/v1/projects/:projectId/sources/:sourceId/mappings',
    createMappingRouter({ mappingService, projects: repos.projects, tokens }),
  );
  app.use(
    '/api/v1/projects/:projectId/sources/:sourceId/staged',
    createStagedRouter({ stagedService, projects: repos.projects, tokens }),
  );
  app.use(
    '/api/v1/projects/:projectId/target-schema',
    createTargetSchemaRouter({ targetSchemas, projects: repos.projects, tokens }),
  );
  app.use(
    '/api/v1/projects/:projectId/sources',
    createSourceRouter({
      sourceService,
      projects: repos.projects,
      tokens,
      uploadRateLimit: {
        max: config.UPLOAD_RATE_LIMIT_MAX,
        windowMs: config.UPLOAD_RATE_LIMIT_WINDOW_MS,
      },
    }),
  );
  app.use('/api/v1/projects/:projectId/jobs', createProjectJobsRouter(jobDeps));
  app.use('/api/v1/jobs', createJobRouter(jobDeps));
  app.use(
    '/api/v1/projects',
    createProjectRouter({ projectService, projects: repos.projects, tokens }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
