import { Schema, model } from 'mongoose';

// Written only by the ai-service LLM gateway (apps/ai-service/app/llm/cost.py, snake_case);
// read here for the dashboard. `strict: false` keeps every field the gateway writes.
const llmCallSchema = new Schema(
  {
    project_id: { type: String, default: null },
    task: { type: String, required: true },
    created_at: { type: Date, required: true },
  },
  { collection: 'llm_calls', strict: false },
);
// The dashboard reads one project's calls in a date range.
llmCallSchema.index({ project_id: 1, created_at: -1 });
export const LlmCallModel = model('LlmCall', llmCallSchema);
