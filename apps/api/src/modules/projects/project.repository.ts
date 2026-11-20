import type { Types } from 'mongoose';

import { ProjectModel, type ProjectDoc } from './project.model.js';
import type { Project, ProjectRepository } from './project.types.js';

type StoredProject = ProjectDoc & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

function toProject(doc: StoredProject): Project {
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    description: doc.description,
    ownerId: doc.ownerId.toHexString(),
    members: doc.members.map((member) => ({
      userId: member.userId.toHexString(),
      role: member.role,
    })),
    status: doc.status,
    currentStep: doc.currentStep,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

const AFTER_UPDATE = { new: true, runValidators: true } as const;

export function createMongoProjectRepository(): ProjectRepository {
  return {
    async create(input) {
      const doc = await ProjectModel.create(input);
      return toProject(doc.toObject());
    },
    async findById(id) {
      const doc = await ProjectModel.findById(id).lean<StoredProject>();
      return doc ? toProject(doc) : null;
    },
    async list(visibleTo, { skip, limit }) {
      const filter = visibleTo
        ? { $or: [{ ownerId: visibleTo }, { 'members.userId': visibleTo }] }
        : {};
      const [docs, total] = await Promise.all([
        ProjectModel.find(filter)
          .sort({ updatedAt: -1, _id: -1 })
          .skip(skip)
          .limit(limit)
          .lean<StoredProject[]>(),
        ProjectModel.countDocuments(filter),
      ]);
      return { items: docs.map(toProject), limit, total };
    },
    async update(id, patch) {
      const doc = await ProjectModel.findByIdAndUpdate(
        id,
        { $set: patch },
        AFTER_UPDATE,
      ).lean<StoredProject>();
      return doc ? toProject(doc) : null;
    },
    async delete(id) {
      const result = await ProjectModel.deleteOne({ _id: id });
      return result.deletedCount === 1;
    },
    async addMember(id, member) {
      const doc = await ProjectModel.findOneAndUpdate(
        { _id: id, 'members.userId': { $ne: member.userId } },
        { $push: { members: member } },
        AFTER_UPDATE,
      ).lean<StoredProject>();
      return doc ? toProject(doc) : null;
    },
    async removeMember(id, userId) {
      const doc = await ProjectModel.findByIdAndUpdate(
        id,
        { $pull: { members: { userId } } },
        AFTER_UPDATE,
      ).lean<StoredProject>();
      return doc ? toProject(doc) : null;
    },
  };
}
