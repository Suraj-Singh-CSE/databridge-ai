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
      const project = oid(projectId);
      // Other customers holding one of these members are superseded by the new approvals.
      await ClusterApprovalModel.deleteMany({
        projectId: project,
        customerId: { $nin: approvals.map((a) => a.customerId) },
        memberKeys: { $in: approvals.flatMap((a) => a.memberKeys) },
      });
      // One upsert per customer (G3-14): idempotent, so two reviewers approving the same
      // customer at once both succeed. The filter is the unique index's exact key, which lets
      // MongoDB retry a racing upsert itself instead of answering E11000.
      await ClusterApprovalModel.bulkWrite(
        approvals.map((a) => ({
          replaceOne: {
            filter: { projectId: project, customerId: a.customerId },
            replacement: { ...a, projectId: project, approvedBy: oid(a.approvedBy) },
            upsert: true,
          },
        })),
        { ordered: false },
      );
    },
    async deleteApprovalsOfRun(projectId, customerIds, runId) {
      if (customerIds.length === 0) return;
      await ClusterApprovalModel.deleteMany({
        projectId: oid(projectId),
        customerId: { $in: customerIds },
        runId,
      });
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
