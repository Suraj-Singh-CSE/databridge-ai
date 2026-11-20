import { createHash } from 'node:crypto';

import bcrypt from 'bcryptjs';

/** Production bcrypt cost (CLAUDE.md rule 4). Tests may inject a lower cost for speed. */
export const BCRYPT_COST = 12;

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

/**
 * bcrypt silently ignores everything after 72 bytes, and our policy allows 128 characters
 * (up to 512 UTF-8 bytes). We therefore bcrypt a base64 SHA-256 digest of the password
 * (44 ASCII bytes), so every character counts and no NUL bytes reach bcrypt.
 */
function prehash(password: string): string {
  return createHash('sha256').update(password, 'utf8').digest('base64');
}

export function createPasswordHasher(cost: number = BCRYPT_COST): PasswordHasher {
  return {
    hash: (password) => bcrypt.hash(prehash(password), cost),
    verify: (password, hash) => bcrypt.compare(prehash(password), hash),
  };
}
