import { createMongoAuditRepository } from './modules/audit/audit.repository.js';
import type { AuditRepository } from './modules/audit/audit.types.js';
import { createMongoRefreshTokenRepository } from './modules/auth/refresh-token.repository.js';
import type { RefreshTokenRepository } from './modules/auth/refresh-token.types.js';
import { createMongoMappingRepository } from './modules/mappings/mapping.repository.js';
import type { MappingRepository } from './modules/mappings/mapping.types.js';
import { createMongoJobRepository } from './modules/jobs/job.repository.js';
import type { JobRepository } from './modules/jobs/job.types.js';
import { createMongoProjectRepository } from './modules/projects/project.repository.js';
import type { ProjectRepository } from './modules/projects/project.types.js';
import { createMongoColumnProfileRepository } from './modules/sources/column-profile.repository.js';
import type { ColumnProfileRepository } from './modules/sources/column-profile.types.js';
import { createMongoSourceRepository } from './modules/sources/source.repository.js';
import type { SourceRepository } from './modules/sources/source.types.js';
import { createMongoTargetSchemaRepository } from './modules/target-schema/target-schema.repository.js';
import type { TargetSchemaRepository } from './modules/target-schema/target-schema.types.js';
import { createMongoUserRepository } from './modules/users/user.repository.js';
import type { UserRepository } from './modules/users/user.types.js';

/** Every persistence dependency of the API. Injected into createApp so tests can swap them. */
export interface Repositories {
  users: UserRepository;
  refreshTokens: RefreshTokenRepository;
  projects: ProjectRepository;
  sources: SourceRepository;
  columnProfiles: ColumnProfileRepository;
  jobs: JobRepository;
  targetSchemas: TargetSchemaRepository;
  mappings: MappingRepository;
  audit: AuditRepository;
}

export function createMongoRepositories(): Repositories {
  return {
    users: createMongoUserRepository(),
    refreshTokens: createMongoRefreshTokenRepository(),
    projects: createMongoProjectRepository(),
    sources: createMongoSourceRepository(),
    columnProfiles: createMongoColumnProfileRepository(),
    jobs: createMongoJobRepository(),
    targetSchemas: createMongoTargetSchemaRepository(),
    mappings: createMongoMappingRepository(),
    audit: createMongoAuditRepository(),
  };
}
