import { z } from 'zod';

import { CLUSTER_FLAGS, CLUSTER_STATUSES } from './cluster.types.js';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id');

export const CLUSTERS_MAX_LIMIT = 100;

export const clusterParams = z.strictObject({ projectId: objectId });

const customerId = z
  .string()
  .regex(/^C[0-9A-F]{12,20}$/, 'must be a customer id such as C1A2B3C4D5E6F');

export const clusterDetailParams = z.strictObject({ projectId: objectId, customerId });

export const REASON_MAX_LENGTH = 300;
const reason = z
  .string()
  .trim()
  .max(REASON_MAX_LENGTH, `must be at most ${REASON_MAX_LENGTH} characters`)
  .optional()
  .transform((value) => (value === '' ? undefined : value));

export const emptyBody = z.strictObject({});

export const splitBody = z.strictObject({ recordId: objectId, reason });

export const mergeBody = z.strictObject({
  customerIds: z
    .tuple([customerId, customerId])
    .refine(([a, b]) => a !== b, 'must be two different customer ids'),
  reason,
});

export const clusterSummaryQuery = z.strictObject({});

export const clusterDetailQuery = z.strictObject({});

export const clusterQuery = z.strictObject({
  status: z.enum(CLUSTER_STATUSES, { error: 'must be proposed, approved or rejected' }).optional(),
  /** `true`: only clusters joined by an AI-suggested link; `false`: only the others. */
  aiSuggested: z
    .enum(['true', 'false'], { error: 'must be true or false' })
    .transform((value) => value === 'true')
    .optional(),
  /** Only clusters carrying this flag, e.g. `needs_review`. */
  flag: z
    .enum(CLUSTER_FLAGS, {
      error: 'must be needs_review, different_people, conflicting_evidence or too_large',
    })
    .optional(),
  /** Only clusters with at least this many records (2 hides single records). */
  minSize: z.coerce.number().int().min(1).max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(CLUSTERS_MAX_LIMIT).default(20),
  /** The `nextCursor` of the previous page (a cluster position). */
  cursor: z
    .string()
    .regex(/^\d{1,9}$/, 'must be the nextCursor of the previous page')
    .transform(Number)
    .optional(),
});
