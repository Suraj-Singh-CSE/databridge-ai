import { z } from 'zod';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id');

export const MAX_QUESTION_CHARS = 500;

export const assistantParams = z.strictObject({ projectId: objectId });
export const conversationParams = z.strictObject({
  projectId: objectId,
  conversationId: objectId,
});
export const askBody = z.strictObject({
  question: z.string().trim().min(1, 'is required').max(MAX_QUESTION_CHARS),
  conversationId: objectId.optional(),
});
export const listConversationsQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
