import type { User } from './user.types.js';

/**
 * The one way the API names a person to other users: their name, or, if that is blank, the
 * part of their email before the @. Never the full email, so a teammate's address is not
 * shown to everyone on the project.
 */
export function displayLabel(user: Pick<User, 'name' | 'email'>): string {
  const name = user.name.trim();
  if (name) return name;
  const localPart = user.email.split('@')[0]?.trim() ?? '';
  return localPart || 'a project member';
}
