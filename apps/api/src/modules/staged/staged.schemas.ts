import { z } from 'zod';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id');

export const STAGED_MAX_LIMIT = 100;

export const stagedParams = z.strictObject({ projectId: objectId, sourceId: objectId });

export const stagedQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(STAGED_MAX_LIMIT).default(50),
  /** The `nextCursor` of the previous page (a row number). */
  cursor: z
    .string()
    .regex(/^\d{1,9}$/, 'must be the nextCursor of the previous page')
    .transform(Number)
    .optional(),
  issues: z.enum(['only', 'all']).default('all'),
});
