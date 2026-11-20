import { z } from 'zod';

const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: 'must be a valid email' }).max(254));

export const registerBody = z.strictObject({
  email,
  name: z.string().trim().min(1, 'is required').max(100),
  password: z
    .string()
    .min(10, 'must be at least 10 characters')
    .max(128, 'must be at most 128 characters'),
});

export const loginBody = z.strictObject({
  email,
  // Length is not checked here: a policy hint on login would help attackers, not users.
  password: z.string().min(1, 'is required').max(128, 'must be at most 128 characters'),
});
