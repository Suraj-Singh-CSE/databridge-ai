import type { Page, PageRequest } from '../../http.js';

export const PROJECT_ROLES = ['data_engineer', 'data_steward', 'viewer'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export const PROJECT_STATUSES = ['active', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_STEPS = [
  'sources',
  'profile',
  'mapping',
  'matching',
  'pipeline',
  'quality',
] as const;
export type ProjectStep = (typeof PROJECT_STEPS)[number];

export interface ProjectMember {
  userId: string;
  role: ProjectRole;
}

/** A current member as other members see them: a display label, never an email. */
export interface ProjectPerson {
  userId: string;
  label: string;
  role: ProjectRole;
  owner: boolean;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  members: ProjectMember[];
  status: ProjectStatus;
  currentStep: ProjectStep;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewProject {
  name: string;
  description: string;
  ownerId: string;
  members: ProjectMember[];
}

export interface ProjectPatch {
  name?: string | undefined;
  description?: string | undefined;
  status?: ProjectStatus | undefined;
  currentStep?: ProjectStep | undefined;
}

export interface ProjectRepository {
  create(input: NewProject): Promise<Project>;
  findById(id: string): Promise<Project | null>;
  /** Newest-updated first. `visibleTo` limits to projects the user owns or is a member of. */
  list(visibleTo: string | null, page: PageRequest): Promise<Omit<Page<Project>, 'page'>>;
  update(id: string, patch: ProjectPatch): Promise<Project | null>;
  delete(id: string): Promise<boolean>;
  /** Adds the member only if not already present; returns null otherwise (or if missing). */
  addMember(id: string, member: ProjectMember): Promise<Project | null>;
  /** Removes the member; returns null if the project is missing. */
  removeMember(id: string, userId: string): Promise<Project | null>;
}
