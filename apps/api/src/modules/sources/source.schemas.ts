import { z } from 'zod';

import { PREVIEW_MAX_ROWS } from './preview.js';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id');

export const projectSourcesParams = z.strictObject({ projectId: objectId });
export const sourceParams = z.strictObject({ projectId: objectId, sourceId: objectId });

const name = z.string().trim().min(1, 'is required').max(80, 'must be at most 80 characters');
const systemName = z
  .string()
  .trim()
  .min(1, 'must not be empty')
  .max(40, 'must be at most 40 characters');

/** HTML forms send blank inputs as "": treat them as "not provided". */
const blankAsMissing = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema,
  );

/** Text fields of the multipart upload (validated after the file is streamed). */
export const uploadFields = z.strictObject({
  name: blankAsMissing(name.optional()),
  systemName: blankAsMissing(systemName.optional()),
});

export const updateSourceBody = z
  .strictObject({
    name: name.optional(),
    systemName: systemName.nullable().optional(),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: 'provide at least one field to change',
  });

export const previewQuery = z.object({
  limit: z.coerce.number().int().min(1).max(PREVIEW_MAX_ROWS).default(20),
});
