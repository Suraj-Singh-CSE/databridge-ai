import { Schema, model, type InferSchemaType } from 'mongoose';

const citationSchema = new Schema(
  {
    n: { type: Number, required: true },
    chunkId: { type: String, required: true },
    kind: { type: String, required: true },
    title: { type: String, required: true },
    link: {
      page: { type: String, required: true },
      params: { type: Schema.Types.Mixed, default: {} },
    },
  },
  { _id: false },
);

const turnSchema = new Schema(
  {
    // Null when the question guard refused it for holding personal data (never stored).
    question: { type: String, default: null },
    answer: { type: String, required: true },
    citations: { type: [citationSchema], default: [] },
    confidence: { type: String, enum: ['high', 'medium', 'low'], required: true },
    answerable: { type: Boolean, required: true },
    refusalReason: { type: String, default: null },
    mode: { type: String, default: null },
    model: { type: String, default: null },
    latencyMs: { type: Number, required: true },
    createdAt: { type: Date, required: true },
  },
  { _id: false },
);

const conversationSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true },
    turns: { type: [turnSchema], default: [] },
  },
  { collection: 'assistant_conversations', timestamps: true },
);
// A user's conversations in a project, newest first.
conversationSchema.index({ projectId: 1, userId: 1, updatedAt: -1 });

export type ConversationDoc = InferSchemaType<typeof conversationSchema>;
export const AssistantConversationModel = model('AssistantConversation', conversationSchema);
