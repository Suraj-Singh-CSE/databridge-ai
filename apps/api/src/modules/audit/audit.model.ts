import { Schema, model, type InferSchemaType, type MongooseQueryMiddleware } from 'mongoose';

const auditLogSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, default: null },
    actorType: { type: String, enum: ['user', 'ai'], required: true },
    actorId: { type: String, required: true },
    action: { type: String, required: true },
    entityType: { type: String, required: true },
    entityId: { type: String, required: true },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    requestId: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'audit_logs' },
);

auditLogSchema.index({ projectId: 1, createdAt: -1 });

// Append-only: refuse every Mongoose write path that would change or remove an entry. The
// retention cap (modules/retention, ADR 0029) trims the oldest entries on the raw collection.
const MUTATING_QUERIES: MongooseQueryMiddleware[] = [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne',
  'findOneAndReplace',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
];
auditLogSchema.pre(MUTATING_QUERIES, () => {
  throw new Error('audit_logs is append-only');
});

export type AuditLogDoc = InferSchemaType<typeof auditLogSchema>;
export const AuditLogModel = model('AuditLog', auditLogSchema);
