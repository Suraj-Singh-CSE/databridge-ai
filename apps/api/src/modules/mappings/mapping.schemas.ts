import { z } from 'zod';

import { MAPPING_ROLES } from './mapping.types.js';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id');

export const mappingsParams = z.strictObject({ projectId: objectId, sourceId: objectId });
export const columnParams = z.strictObject({
  projectId: objectId,
  sourceId: objectId,
  column: z.string().min(1, 'is required').max(200, 'must be at most 200 characters'),
});

const DATE_FORMATS = ['DD/MM/YYYY', 'DD-MM-YYYY', 'YYYY-MM-DD', 'YYYY/MM/DD', 'DD-Mon-YYYY'];
const SIMPLE_TRANSFORMS = [
  'trim',
  'lowercase',
  'uppercase',
  'title_case',
  'city',
  'digits_only',
  'to_e164_in',
  'split_name',
  'concat',
];
/** The transform hints the cleaning step understands (same list as the ai-service rules). */
export const TRANSFORMS = [...SIMPLE_TRANSFORMS, ...DATE_FORMATS.map((f) => `parse_date:${f}`)];

const transform = z
  .string()
  .refine((value) => TRANSFORMS.includes(value), {
    message: `must be one of: ${TRANSFORMS.join(', ')}`,
  })
  .nullable()
  .default(null);

/** PATCH body. `override` sets the mapping by hand; a field needs a target, other roles none. */
export const decideBody = z
  .discriminatedUnion(
    'decision',
    [
      z.strictObject({ decision: z.literal('accept') }),
      z.strictObject({ decision: z.literal('reject') }),
      z.strictObject({
        decision: z.literal('override'),
        role: z.enum(MAPPING_ROLES),
        target: z.string().trim().min(1).max(64).nullable().default(null),
        transform,
      }),
    ],
    { error: 'must be accept, reject or override' },
  )
  .superRefine((body, ctx) => {
    if (body.decision !== 'override') return;
    if (body.role === 'field' && body.target === null) {
      ctx.addIssue({ code: 'custom', message: 'is required for role "field"', path: ['target'] });
    }
    if (body.role !== 'field' && body.target !== null) {
      ctx.addIssue({
        code: 'custom',
        message: `must be null for role "${body.role}"`,
        path: ['target'],
      });
    }
  });
export type DecideBody = z.output<typeof decideBody>;
