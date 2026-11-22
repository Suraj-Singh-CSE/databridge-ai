import { Types } from 'mongoose';

import {
  ClusterApprovalModel,
  MatchDecisionModel,
  type ClusterApprovalDoc,
} from './cluster.model.js';
import type { ClusterApproval, PairDecisionValue, ReviewRepository } from './cluster.types.js';

const oid = (id: string) => new Types.ObjectId(id);

function toApproval(doc: ClusterApprovalDoc): ClusterApproval {
  return {
    customerId: doc.customerId,
    memberKeys: [...doc.memberKeys],
    approvedBy: doc.approvedBy.toHexString(),
    approvedAt: doc.approvedAt,
    runId: doc.runId,
  };
}

export function createMongoReviewRepository(): ReviewRepository {
  return {
    async savePairDecisions(projectId, decisions) {
      if (decisions.length === 0) return;
      await MatchDecisionModel.bulkWrite(
        decisions.map((d) => ({
          replaceOne: {
            filter: { projectId: oid(projectId), keyA: d.keyA, keyB: d.keyB },
            replacement: {
              ...d,
              projectId: oid(projectId),
              recordA: oid(d.recordA),
              recordB: oid(d.recordB),
              decidedBy: oid(d.decidedBy),
            },
            upsert: true,
          },
        })),
        { ordered: false },
      );
    },
    async countPairDecisions(projectId) {
      const rows = await MatchDecisionModel.aggregate<{ _id: PairDecisionValue; count: number }>([
        { $match: { projectId: oid(projectId) } },
        { $group: { _id: '$decision', count: { $sum: 1 } } },
      ]);
      const counts: Record<PairDecisionValue, number> = { same: 0, different: 0 };
      for (const row of rows) counts[row._id] = row.count;
      return counts;
    },
    async deleteApprovalDecisions(projectId, customerId) {
      await MatchDecisionModel.deleteMany({ projectId, customerId, action: 'approve' });
    },
    async saveApprovals(projectId, approvals) {
      if (approvals.length === 0) return;
      const keys = approvals.flatMap((a) => a.memberKeys);
      await ClusterApprovalModel.deleteMany({
        projectId,
        $or: [
          { memberKeys: { $in: keys } },
          { customerId: { $in: approvals.map((a) => a.customerId) } },
        ],
      });
      await ClusterApprovalModel.insertMany(
        approvals.map((a) => ({ projectId, ...a })),
        { ordered: false },
      );
    },
    async listApprovals(projectId) {
      const docs = await ClusterApprovalModel.find({ projectId }).lean<ClusterApprovalDoc[]>();
      return docs.map(toApproval);
    },
    async findApprovalsByKeys(projectId, keys) {
      if (keys.length === 0) return [];
      const docs = await ClusterApprovalModel.find({
        projectId,
        memberKeys: { $in: keys },
      }).lean<ClusterApprovalDoc[]>();
      return docs.map(toApproval);
    },
    async deleteApproval(projectId, customerId) {
      const doc = await ClusterApprovalModel.findOneAndDelete({
        projectId,
        customerId,
      }).lean<ClusterApprovalDoc>();
      return doc ? toApproval(doc) : null;
    },
    async deleteByProject(projectId) {
      await MatchDecisionModel.deleteMany({ projectId });
      await ClusterApprovalModel.deleteMany({ projectId });
    },
  };
}
