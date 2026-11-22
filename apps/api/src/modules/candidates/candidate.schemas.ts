import { z } from 'zod';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id');

export const CANDIDATES_MAX_LIMIT = 100;

export const candidateParams = z.strictObject({ projectId: objectId });

export const summaryQuery = z.strictObject({});

export const candidateQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(CANDIDATES_MAX_LIMIT).default(20),
  /** The `nextCursor` of the previous page (a pair position). */
  cursor: z
    .string()
    .regex(/^\d{1,9}$/, 'must be the nextCursor of the previous page')
    .transform(Number)
    .optional(),
});
