import { z } from 'zod';

import { SCORE_BANDS } from './score.types.js';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id');

export const SCORES_MAX_LIMIT = 100;

export const scoreParams = z.strictObject({ projectId: objectId });

export const scoreSummaryQuery = z.strictObject({});

export const scoreQuery = z.strictObject({
  /** Only this band; every band (highest score first) when absent. */
  band: z.enum(SCORE_BANDS, { error: 'must be match, maybe or non_match' }).optional(),
  limit: z.coerce.number().int().min(1).max(SCORES_MAX_LIMIT).default(20),
  /** The `nextCursor` of the previous page (a score position). */
  cursor: z
    .string()
    .regex(/^\d{1,9}$/, 'must be the nextCursor of the previous page')
    .transform(Number)
    .optional(),
});
