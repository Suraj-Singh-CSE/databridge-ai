import { z } from 'zod';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id');

export const exportsParams = z.strictObject({ projectId: objectId });
export const exportParams = z.strictObject({ projectId: objectId, exportId: objectId });
export const listExportsQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
