import { Schema, model, type InferSchemaType } from 'mongoose';

import { ROLES } from './user.types.js';

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ROLES, required: true },
  },
  {
    timestamps: true,
    toJSON: {
      // Defence in depth: even if a raw document is serialised, the hash never leaves the API.
      transform: (_doc, ret: Record<string, unknown>) => {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.__v;
        delete ret.passwordHash;
        return ret;
      },
    },
  },
);

export type UserDoc = InferSchemaType<typeof userSchema>;
export const UserModel = model('User', userSchema);

/** One-document-per-key collection used for atomic one-time claims (first admin). */
const appMetaSchema = new Schema({ _id: String, claimedAt: Date }, { versionKey: false });
export const AppMetaModel = model('AppMeta', appMetaSchema, 'app_meta');
