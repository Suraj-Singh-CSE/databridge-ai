import { Schema, model, type InferSchemaType } from 'mongoose';

/** Written by the standardise worker (apps/ai-service/app/standardise/store.py); the api reads. */
const stagedRecordSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    sourceId: { type: Schema.Types.ObjectId, ref: 'Source', required: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true },
    runId: { type: String, required: true },
    rowNumber: { type: Number, required: true },
    sourceRecordId: { type: String, default: null },
    // Target field -> cleaned value; the field names come from the project's target schema.
    fields: { type: Schema.Types.Mixed, required: true },
    issues: {
      type: [
        new Schema(
          { field: { type: String, required: true }, code: { type: String, required: true } },
          { _id: false },
        ),
      ],
      default: [],
    },
    hasIssues: { type: Boolean, required: true },
    createdAt: { type: Date, required: true },
  },
  { collection: 'staged_records' },
);
// One row per run; the worker creates the same index.
stagedRecordSchema.index({ projectId: 1, sourceId: 1, runId: 1, rowNumber: 1 }, { unique: true });

export type StagedRecordDoc = InferSchemaType<typeof stagedRecordSchema>;
export const StagedRecordModel = model('StagedRecord', stagedRecordSchema);
