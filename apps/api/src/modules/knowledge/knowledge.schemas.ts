import { z } from 'zod';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id');

export const knowledgeParams = z.strictObject({ projectId: objectId });
