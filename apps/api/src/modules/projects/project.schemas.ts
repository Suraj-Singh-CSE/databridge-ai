import { z } from 'zod';

import { PROJECT_ROLES, PROJECT_STATUSES, PROJECT_STEPS } from './project.types.js';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id');

export const projectIdParams = z.strictObject({ id: objectId });
export const memberParams = z.strictObject({ id: objectId, userId: objectId });

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const name = z.string().trim().min(1, 'is required').max(80, 'must be at most 80 characters');
const description = z.string().trim().max(500, 'must be at most 500 characters');

export const createProjectBody = z.strictObject({
  name,
  description: description.default(''),
});

export const updateProjectBody = z
  .strictObject({
    name: name.optional(),
    description: description.optional(),
    status: z.enum(PROJECT_STATUSES).optional(),
    currentStep: z.enum(PROJECT_STEPS).optional(),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: 'provide at least one field to change',
  });

export const addMemberBody = z.strictObject({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email({ error: 'must be a valid email' })),
  role: z.enum(PROJECT_ROLES),
});
