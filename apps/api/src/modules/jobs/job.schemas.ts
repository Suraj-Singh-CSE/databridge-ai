import { z } from 'zod';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id');

export const projectJobsParams = z.strictObject({ projectId: objectId });
export const jobParams = z.strictObject({ jobId: objectId });

export const listJobsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** `demo`: N steps of `stepMs` each, optionally failing at one step (tests and smoke test). */
const demoPayload = z
  .strictObject({
    steps: z.int().min(1).max(20),
    stepMs: z.int().min(10).max(2000),
    failAtStep: z.int().min(1).max(20).optional(),
  })
  .refine((p) => p.failAtStep === undefined || p.failAtStep <= p.steps, {
    message: 'must not be greater than steps',
    path: ['failAtStep'],
  });

/** `profile`: profile one source of the job's project (apps/ai-service handlers/profile.py). */
const profilePayload = z.strictObject({ sourceId: objectId });

/** `mapping`: suggest target fields for one profiled source (handlers/mapping.py). */
const mappingPayload = z.strictObject({ sourceId: objectId });

/** `standardise`: apply the reviewed mapping to every row (handlers/standardise.py). */
const standardisePayload = z.strictObject({ sourceId: objectId });

/** `candidates`: project-level, every standardised source together (handlers/candidates.py). */
const candidatesPayload = z.strictObject({});

/** `scoring`: project-level, the current candidate pairs (handlers/scoring.py). */
const scoringPayload = z.strictObject({});

/** `pair_review`: project-level, the maybe pairs of the current scores (handlers/pair_review.py). */
const pairReviewPayload = z.strictObject({});

/** `clustering`: project-level, the records of the current scores (handlers/clustering.py). */
const clusteringPayload = z.strictObject({});

/**
 * One entry per job type that can be started. A new type adds its payload schema here and its
 * handler in apps/ai-service/app/worker/handlers (the ai-service validates the payload again).
 */
export const createJobBody = z.discriminatedUnion(
  'type',
  [
    z.strictObject({ type: z.literal('demo'), payload: demoPayload }),
    z.strictObject({ type: z.literal('profile'), payload: profilePayload }),
    z.strictObject({ type: z.literal('mapping'), payload: mappingPayload }),
    z.strictObject({ type: z.literal('standardise'), payload: standardisePayload }),
    z.strictObject({ type: z.literal('candidates'), payload: candidatesPayload }),
    z.strictObject({ type: z.literal('scoring'), payload: scoringPayload }),
    z.strictObject({ type: z.literal('pair_review'), payload: pairReviewPayload }),
    z.strictObject({ type: z.literal('clustering'), payload: clusteringPayload }),
  ],
  { error: 'unknown job type' },
);
