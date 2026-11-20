import { describe, expect, it } from 'vitest';

import { BCRYPT_COST, createPasswordHasher } from '../src/modules/auth/password.js';

describe('password hashing', () => {
  it('uses bcrypt cost 12 by default', async () => {
    const hash = await createPasswordHasher().hash('a long enough password');

    expect(BCRYPT_COST).toBe(12);
    expect(hash).toMatch(/^\$2b\$12\$/);
  });

  it('verifies the right password and rejects others', async () => {
    const hasher = createPasswordHasher(4);
    const hash = await hasher.hash('correct horse battery');

    expect(await hasher.verify('correct horse battery', hash)).toBe(true);
    expect(await hasher.verify('correct horse battery!', hash)).toBe(false);
  });

  it('uses every character, even beyond bcrypt’s 72-byte limit', async () => {
    const hasher = createPasswordHasher(4);
    const base = 'p'.repeat(100);
    const hash = await hasher.hash(`${base}A`);

    expect(await hasher.verify(`${base}B`, hash)).toBe(false);
  });
});
