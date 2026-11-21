import mongoose from 'mongoose';

import { AuditLogModel } from './modules/audit/audit.model.js';
import { JobModel } from './modules/jobs/job.model.js';
import { RefreshTokenModel } from './modules/auth/refresh-token.model.js';
import { ProjectModel } from './modules/projects/project.model.js';
import { SourceModel } from './modules/sources/source.model.js';
import { UserModel } from './modules/users/user.model.js';

const MODELS = [
  UserModel,
  RefreshTokenModel,
  ProjectModel,
  SourceModel,
  JobModel,
  AuditLogModel,
] as const;

export interface ConnectOptions {
  serverSelectionTimeoutMS?: number;
}

/**
 * Connects Mongoose and builds every index (unique email, TTL on refresh tokens, members.userId,
 * unique source sha256 per project)
 * before the API accepts requests, so uniqueness is enforced from the first request.
 */
export async function connectDb(uri: string, options: ConnectOptions = {}): Promise<void> {
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: options.serverSelectionTimeoutMS ?? 10_000,
  });
  await Promise.all(MODELS.map((model) => model.init()));
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}
