import type { Project } from '@/lib/api-types';

const ROLE_NAMES = {
  data_engineer: 'a data engineer',
  data_steward: 'a data steward',
  viewer: 'a viewer',
} as const;

/**
 * Who did something, in plain words. The api records user ids only; the project tells us the
 * owner and each member's role, which is enough to say "you", "the owner" or "a data engineer".
 */
export function personLabel(
  userId: string | null,
  project: Project,
  currentUserId: string | undefined,
): string {
  if (userId === null) return 'the system';
  if (userId === currentUserId) return 'you';
  if (userId === project.ownerId) return 'the project owner';
  const member = project.members.find((m) => m.userId === userId);
  return member ? ROLE_NAMES[member.role] : 'a former member or an admin';
}
