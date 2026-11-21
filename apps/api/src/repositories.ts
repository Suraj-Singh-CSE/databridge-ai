import { createMongoAuditRepository } from './modules/audit/audit.repository.js';
import type { AuditRepository } from './modules/audit/audit.types.js';
import { createMongoRefreshTokenRepository } from './modules/auth/refresh-token.repository.js';
import type { RefreshTokenRepository } from './modules/auth/refresh-token.types.js';
import { createMongoJobRepository } from './modules/jobs/job.repository.js';
import type { JobRepository } from './modules/jobs/job.types.js';
import { createMongoProjectRepository } from './modules/projects/project.repository.js';
import type { ProjectRepository } from './modules/projects/project.types.js';
import { createMongoSourceRepository } from './modules/sources/source.repository.js';
import type { SourceRepository } from './modules/sources/source.types.js';
import { createMongoUserRepository } from './modules/users/user.repository.js';
import type { UserRepository } from './modules/users/user.types.js';

/** Every persistence dependency of the API. Injected into createApp so tests can swap them. */
export interface Repositories {
  users: UserRepository;
  refreshTokens: RefreshTokenRepository;
  projects: ProjectRepository;
  sources: SourceRepository;
  jobs: JobRepository;
  audit: AuditRepository;
}

export function createMongoRepositories(): Repositories {
  return {
    users: createMongoUserRepository(),
    refreshTokens: createMongoRefreshTokenRepository(),
    projects: createMongoProjectRepository(),
    sources: createMongoSourceRepository(),
    jobs: createMongoJobRepository(),
    audit: createMongoAuditRepository(),
  };
}
