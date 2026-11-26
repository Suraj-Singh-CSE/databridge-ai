import { useAuth } from '@/features/auth/auth-context';
import { useProjectPeople } from '@/features/projects/queries';
import type { ProjectPerson } from '@/lib/api-types';

/** Names "who did it" in a history line: a user id, or null for the system. */
export type PersonOf = (userId: string | null) => string;

/**
 * Who did something, in plain words. The api records user ids only and gives display labels
 * (a name, never an email) for current members only, so anyone else is "a former member".
 */
export function personLabel(
  userId: string | null,
  people: readonly ProjectPerson[] | undefined,
  currentUserId: string | undefined,
): string {
  if (userId === null) return 'the system';
  if (userId === currentUserId) return 'you';
  // Until the member list loads (or if it fails), stay neutral rather than guess.
  if (!people) return 'a project member';
  return people.find((person) => person.userId === userId)?.label ?? 'a former member';
}

/** `personLabel` bound to a project's members and the signed-in user. */
export function usePersonOf(projectId: string): PersonOf {
  const { user } = useAuth();
  const people = useProjectPeople(projectId);
  return (userId) => personLabel(userId, people.data, user?.id);
}
