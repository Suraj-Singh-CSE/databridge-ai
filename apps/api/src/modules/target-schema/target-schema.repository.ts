import type { Types } from 'mongoose';

import { isDuplicateKeyError } from '../../mongo-errors.js';

import { TargetSchemaModel, type TargetSchemaDoc } from './target-schema.model.js';
import type { TargetField, TargetSchema, TargetSchemaRepository } from './target-schema.types.js';

type StoredSchema = TargetSchemaDoc & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

function toField(field: TargetSchemaDoc['fields'][number]): TargetField {
  return {
    name: field.name,
    type: field.type,
    format: field.format ?? null,
    description: field.description,
    isPii: field.isPii,
    generated: field.generated,
    required: field.required,
    allowConcat: field.allowConcat,
  };
}

function toSchema(doc: StoredSchema): TargetSchema {
  return {
    projectId: doc.projectId.toHexString(),
    name: doc.name,
    version: doc.version,
    fields: doc.fields.map(toField),
    updatedBy: doc.updatedBy ? doc.updatedBy.toHexString() : null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export function createMongoTargetSchemaRepository(): TargetSchemaRepository {
  async function find(projectId: string): Promise<TargetSchema | null> {
    const doc = await TargetSchemaModel.findOne({ projectId }).lean<StoredSchema>();
    return doc ? toSchema(doc) : null;
  }

  return {
    findByProject: find,
    async createIfMissing(projectId, input) {
      try {
        const doc = await TargetSchemaModel.create({ projectId, version: 1, ...input });
        return toSchema(doc.toObject());
      } catch (error) {
        // Two first reads at once: the other one created it.
        if (!isDuplicateKeyError(error)) throw error;
        const existing = await find(projectId);
        if (!existing) throw error;
        return existing;
      }
    },
    async replace(projectId, expectedVersion, input, updatedBy) {
      const doc = await TargetSchemaModel.findOneAndUpdate(
        { projectId, version: expectedVersion },
        { $set: { ...input, updatedBy }, $inc: { version: 1 } },
        { new: true, runValidators: true },
      ).lean<StoredSchema>();
      return doc ? toSchema(doc) : null;
    },
    async deleteByProject(projectId) {
      const result = await TargetSchemaModel.deleteMany({ projectId });
      return result.deletedCount;
    },
  };
}
