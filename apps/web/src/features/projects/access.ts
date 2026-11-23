import type { Project, ProjectRole, User } from '@/lib/api-types';

/** What a user may do in one project; mirrors apps/api middleware/require-project-access.ts. */
export type ProjectAccess = ProjectRole | 'owner' | 'admin';

export function projectAccessOf(project: Project, user: User): ProjectAccess | null {
  if (user.role === 'admin') return 'admin';
  if (project.ownerId === user.id) return 'owner';
  return project.members.find((member) => member.userId === user.id)?.role ?? null;
}

/**
 * Upload, profile and delete sources (and start or cancel their jobs): owner, admin or a
 * data_engineer member. The api enforces the same rule; this only decides what the UI offers.
 */
export function canManageSources(access: ProjectAccess | null): boolean {
  return access === 'admin' || access === 'owner' || access === 'data_engineer';
}

/** Short reason shown to members who can look but not change sources. */
export const READ_ONLY_SOURCES_NOTE =
  'You can view these files. Only the project owner, an admin or a data engineer can upload, profile or remove them.';

/** Start or re-run the mapping job: the same people who manage sources. */
export const canRunMapping = canManageSources;

/** Accept, reject or change a mapping suggestion: those above, plus data_steward members. */
export function canReviewMappings(access: ProjectAccess | null): boolean {
  return canManageSources(access) || access === 'data_steward';
}

export const READ_ONLY_MAPPING_NOTE =
  'You can view these suggestions. Only the project owner, an admin, a data engineer or a data steward can accept or change them.';

/** Start or cancel the matching jobs (clean, find pairs, score, AI review, group). */
export const canRunMatching = canManageSources;

export const READ_ONLY_MATCHING_NOTE =
  'You can view the matching results. Only the project owner, an admin or a data engineer can run the matching steps.';

/** Approve, split and merge proposed customers: those who review mappings (stewards and up). */
export const canReviewMatches = canReviewMappings;

export const STEWARD_MATCHING_NOTE =
  'You can approve, split and merge customers. Only the project owner, an admin or a data engineer can run the matching steps.';

/** Draft, approve, reject and run SQL, and delete exports: the same people who manage sources. */
export const canManagePipeline = canManageSources;

/** Start an export (ADR 0020): those who review customers, so data stewards too. */
export const canStartExport = canReviewMappings;

export const READ_ONLY_PIPELINE_NOTE =
  'You can view the SQL and download exports. Only the project owner, an admin or a data engineer can draft, approve or run SQL; data stewards can also start exports.';

export const STEWARD_PIPELINE_NOTE =
  'You can view the SQL, and start and download exports. Only the project owner, an admin or a data engineer can draft, approve or run SQL, or delete exports.';

/** Run the quality checks (ADR 0022): data stewards and up. */
export const canRunQuality = canReviewMappings;

/** Change the quality thresholds: the same people who manage sources. */
export const canManageQuality = canManageSources;

export const READ_ONLY_QUALITY_NOTE =
  'You can view the quality reports. Only the project owner, an admin, a data engineer or a data steward can run the checks, and only a data engineer, the owner or an admin can change the thresholds.';

export const STEWARD_QUALITY_NOTE =
  'You can view the quality reports and run the checks. Only the project owner, an admin or a data engineer can change the thresholds.';
