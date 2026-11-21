import { z } from 'zod';

import { FIELD_TYPES } from './target-schema.types.js';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id');

export const MAX_FIELDS = 100;
const SNAKE_CASE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

export const targetSchemaParams = z.strictObject({ projectId: objectId });

const targetField = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1, 'is required')
    .max(64, 'must be at most 64 characters')
    .regex(SNAKE_CASE, 'must be snake_case (lower-case letters, digits and underscores)'),
  type: z.enum(FIELD_TYPES, { error: `must be one of: ${FIELD_TYPES.join(', ')}` }),
  format: z.string().trim().max(120, 'must be at most 120 characters').nullable().default(null),
  description: z.string().trim().max(500, 'must be at most 500 characters').default(''),
  isPii: z.boolean().default(false),
  generated: z.boolean().default(false),
  required: z.boolean().default(false),
  allowConcat: z.boolean().default(false),
});

/** PUT body: the whole schema. `baseVersion`, when given, must be the current version. */
export const replaceTargetSchemaBody = z
  .strictObject({
    name: z.string().trim().min(1, 'is required').max(80, 'must be at most 80 characters'),
    baseVersion: z.int().min(1).optional(),
    fields: z
      .array(targetField)
      .min(1, 'add at least one field')
      .max(MAX_FIELDS, `must have at most ${MAX_FIELDS} fields`),
  })
  .superRefine(({ fields }, ctx) => {
    const seen = new Set<string>();
    fields.forEach((field, index) => {
      if (seen.has(field.name)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate field name "${field.name}"`,
          path: ['fields', index, 'name'],
        });
      }
      seen.add(field.name);
    });
    if (!fields.some((field) => !field.generated)) {
      ctx.addIssue({
        code: 'custom',
        message: 'at least one field must be mappable (not generated)',
        path: ['fields'],
      });
    }
  });
