import { z } from 'zod';

import { CLUSTER_FLAGS, CLUSTER_STATUSES } from './cluster.types.js';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id');

export const CLUSTERS_MAX_LIMIT = 100;

export const clusterParams = z.strictObject({ projectId: objectId });

export const clusterDetailParams = z.strictObject({
  projectId: objectId,
  customerId: z.string().regex(/^C[0-9A-F]{12,20}$/, 'must be a customer id such as C1A2B3C4D5E6F'),
});

export const clusterSummaryQuery = z.strictObject({});

export const clusterDetailQuery = z.strictObject({});

export const clusterQuery = z.strictObject({
  status: z.enum(CLUSTER_STATUSES, { error: 'must be proposed, approved or rejected' }).optional(),
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
