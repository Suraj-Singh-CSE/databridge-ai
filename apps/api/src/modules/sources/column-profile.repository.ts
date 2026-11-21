import { ColumnProfileModel, type ColumnProfileDoc } from './column-profile.model.js';
import type {
  ColumnProfile,
  ColumnProfileRepository,
  PatternMatch,
  QualityFlag,
  TopValue,
} from './column-profile.types.js';

const scalar = (value: unknown): number | string | null =>
  typeof value === 'number' || typeof value === 'string' ? value : null;

export function toColumnProfile(doc: ColumnProfileDoc): ColumnProfile {
  return {
    column: doc.column,
    position: doc.position,
    inferredType: doc.inferredType,
    rowCount: doc.rowCount,
    emptyCount: doc.emptyCount,
    emptyPercent: doc.emptyPercent,
    distinctCount: doc.distinctCount,
    uniquePercent: doc.uniquePercent,
    min: scalar(doc.min),
    max: scalar(doc.max),
    minLength: doc.minLength ?? null,
    maxLength: doc.maxLength ?? null,
    avgLength: doc.avgLength ?? null,
    topValues: doc.topValues as TopValue[],
    samples: doc.samples,
    patterns: doc.patterns as PatternMatch[],
    flags: doc.flags as QualityFlag[],
    personal: doc.personal,
    profileVersion: doc.profileVersion,
    createdAt: doc.createdAt,
  };
}

export function createMongoColumnProfileRepository(): ColumnProfileRepository {
  return {
    async listBySource(projectId, sourceId) {
      const docs = await ColumnProfileModel.find({ projectId, sourceId })
        .sort({ position: 1 })
        .lean<ColumnProfileDoc[]>();
      return docs.map(toColumnProfile);
    },
    async deleteBySource(projectId, sourceId) {
      const result = await ColumnProfileModel.deleteMany({ projectId, sourceId });
      return result.deletedCount;
    },
    async deleteByProject(projectId) {
      const result = await ColumnProfileModel.deleteMany({ projectId });
      return result.deletedCount;
    },
  };
}
