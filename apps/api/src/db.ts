import mongoose from 'mongoose';

import { AuditLogModel } from './modules/audit/audit.model.js';
import { RefreshTokenModel } from './modules/auth/refresh-token.model.js';
import { ProjectModel } from './modules/projects/project.model.js';
import { UserModel } from './modules/users/user.model.js';

const MODELS = [UserModel, RefreshTokenModel, ProjectModel, AuditLogModel] as const;

export interface ConnectOptions {
  serverSelectionTimeoutMS?: number;
}

/**
 * Connects Mongoose and builds every index (unique email, TTL on refresh tokens, members.userId)
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
