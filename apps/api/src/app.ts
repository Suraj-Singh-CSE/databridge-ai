import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';

import { createAiServiceClient, type AiServiceClient } from './ai-service.client.js';
import { pingDb } from './db.js';
import { runReadiness, type ReadinessChecks } from './readiness.js';
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
import { createCandidateRouter } from './modules/candidates/candidate.routes.js';
import { createCandidateService } from './modules/candidates/candidate.service.js';
import { createClusterRouter } from './modules/clusters/cluster.routes.js';
import { createClusterService } from './modules/clusters/cluster.service.js';
import { createReviewService } from './modules/clusters/review.service.js';
import { createDashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { createDashboardService } from './modules/dashboard/dashboard.service.js';
import { createKnowledgeRouter } from './modules/knowledge/knowledge.routes.js';
import { createExportRouter } from './modules/exports/export.routes.js';
import { createExportService } from './modules/exports/export.service.js';
import { createQualityRouter } from './modules/quality/quality.routes.js';
import { createQualityService } from './modules/quality/quality.service.js';
import { createSqlRouter } from './modules/sql/sql.routes.js';
import { createAssistantRouter } from './modules/assistant/assistant.routes.js';
import { createAssistantService } from './modules/assistant/assistant.service.js';
import { createQuestionLimiter } from './modules/assistant/rate-limit.js';
import { createSqlService } from './modules/sql/sql.service.js';
import { createScoreRouter } from './modules/scores/score.routes.js';
import { createScoreService } from './modules/scores/score.service.js';
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
  /** Checks for GET /api/v1/ready; defaults to MongoDB (mongoose) and Redis (the event bus). */
  readiness?: ReadinessChecks;
}

export function createApp({
  config,
  logger,
  repos,
  passwords,
  storage,
  jobEvents,
  aiService,
  readiness,
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
  const candidateService = createCandidateService(repos);
  const scoreService = createScoreService(repos);
  const clusterService = createClusterService(repos);
  const aiClient = aiService ?? createAiServiceClient(config);
  const jobService = createJobService({
    repos,
    targetSchemas,
    audit,
    events: jobEvents,
    aiService: aiClient,
    logger,
    staleAfterMs: config.JOB_STALE_AFTER_SECONDS * 1000,
    queuedStaleAfterMs: config.JOB_QUEUED_STALE_AFTER_SECONDS * 1000,
  });
  const reviewService = createReviewService(repos, jobService, audit);
  const exportService = createExportService(repos, files, audit);
  const sqlService = createSqlService(repos, audit);
  const qualityService = createQualityService(repos, audit);
  const dashboardService = createDashboardService(repos);
  const assistantService = createAssistantService({
    conversations: repos.assistant,
    knowledge: repos.knowledge,
    dashboard: repos.dashboard,
    aiService: aiClient,
    audit,
    limiter: createQuestionLimiter(
      config.ASSISTANT_RATE_LIMIT_MAX,
      config.ASSISTANT_RATE_LIMIT_WINDOW_MS,
    ),
    logger,
    maxTurns: config.ASSISTANT_MAX_TURNS,
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

  // Liveness: the process answers. Readiness: its dependencies answer too (ADR 0026).
  app.get('/api/v1/health', (_req, res) => {
    res.json({ data: { status: 'ok', service: 'api' }, error: null });
  });
  const checks = readiness ?? { mongodb: pingDb, redis: () => jobEvents.ping() };
  app.get('/api/v1/ready', async (_req, res) => {
    const results = await runReadiness(checks);
    if (Object.values(results).every((result) => result === 'ok')) {
      res.json({ data: { status: 'ready', checks: results }, error: null });
      return;
    }
    res.status(503).json({
      data: null,
      error: {
        code: 'NOT_READY',
        message: 'A dependency is unavailable.',
        details: { checks: results },
      },
    });
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
    '/api/v1/projects/:projectId/candidates',
    createCandidateRouter({ candidateService, projects: repos.projects, tokens }),
  );
  app.use(
    '/api/v1/projects/:projectId/scores',
    createScoreRouter({ scoreService, projects: repos.projects, tokens }),
  );
  app.use(
    '/api/v1/projects/:projectId/clusters',
    createClusterRouter({ clusterService, reviewService, projects: repos.projects, tokens }),
  );
  app.use(
    '/api/v1/projects/:projectId/exports',
    createExportRouter({ exportService, projects: repos.projects, tokens }),
  );
  app.use(
    '/api/v1/projects/:projectId/sql',
    createSqlRouter({ sqlService, projects: repos.projects, tokens }),
  );
  app.use(
    '/api/v1/projects/:projectId/quality',
    createQualityRouter({ qualityService, projects: repos.projects, tokens }),
  );
  app.use(
    '/api/v1/projects/:projectId/dashboard',
    createDashboardRouter({ dashboardService, projects: repos.projects, tokens, logger }),
  );
  app.use(
    '/api/v1/projects/:projectId/knowledge',
    createKnowledgeRouter({ knowledge: repos.knowledge, projects: repos.projects, tokens }),
  );
  app.use(
    '/api/v1/projects/:projectId/assistant',
    createAssistantRouter({ assistantService, projects: repos.projects, tokens }),
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
