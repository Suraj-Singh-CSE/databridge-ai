/**
 * Shapes returned by apps/api (/api/v1), as JSON. Keep in step with
 * apps/api/src/modules/{users,projects}/*.types.ts. Dates arrive as ISO strings.
 */

export const ROLES = ['admin', 'data_engineer', 'data_steward', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
  updatedAt: string;
}

/** Body of register, login and refresh responses. */
export interface AuthSession {
  user: User;
  accessToken: string;
}

export const PROJECT_STEPS = [
  'sources',
  'profile',
  'mapping',
  'matching',
  'pipeline',
  'quality',
] as const;
export type ProjectStep = (typeof PROJECT_STEPS)[number];

export type ProjectStatus = 'active' | 'archived';
export type ProjectRole = 'data_engineer' | 'data_steward' | 'viewer';

export interface Project {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  members: { userId: string; role: ProjectRole }[];
  status: ProjectStatus;
  currentStep: ProjectStep;
  createdAt: string;
  updatedAt: string;
}

export interface Page<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
}

/** Error codes the api can return, plus NETWORK_ERROR for requests that never got an answer. */
export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'NETWORK_ERROR';

/** `details` of a VALIDATION_ERROR. */
export interface FieldIssue {
  field: string;
  message: string;
}
