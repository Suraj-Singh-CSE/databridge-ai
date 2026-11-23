import { z } from 'zod';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id');

export const sqlVersionsParams = z.strictObject({ projectId: objectId });
export const sqlVersionParams = z.strictObject({ projectId: objectId, versionId: objectId });
export const listSqlVersionsQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const approveSqlBody = z.strictObject({});
export const rejectSqlBody = z.strictObject({
  reason: z.string().trim().min(1).max(500).optional(),
});
