import { Types } from 'mongoose';

import { AuditLogModel } from '../audit/audit.model.js';
import { ExportModel } from '../exports/export.model.js';
import { JobModel } from '../jobs/job.model.js';
import type { JobStatus, JobType } from '../jobs/job.types.js';
import { MappingDecisionModel, MappingSuggestionModel } from '../mappings/mapping.model.js';
import { QualityRunModel } from '../quality/quality.model.js';

import type {
  AuditCount,
  DashboardRepository,
  LlmDay,
  LlmErrorCount,
  LlmTaskTotals,
  QualityPoint,
} from './dashboard.types.js';
import { LlmCallModel } from './llm-call.model.js';

const oid = (id: string) => new Types.ObjectId(id);

interface JobFacets {
  counts: { _id: { type: JobType; status: JobStatus; code?: string | null }; count: number }[];
  durations: { _id: JobType; ms: number[] }[];
  failures: { type: JobType; code?: string | null; at: Date }[];
}

interface LlmFacets {
  tasks: (Omit<LlmTaskTotals, 'task' | 'latenciesMs'> & { _id: string })[];
  latencies: { _id: string; ms: number[] }[];
  errors: {
    _id: { task: string; status?: string | null; code?: number | null; type?: string | null };
    count: number;
  }[];
  days: (Omit<LlmDay, 'date'> & { _id: string })[];
}

/** Aggregation pipelines over the collections other modules own (one round trip each). */
export function createMongoDashboardRepository(): DashboardRepository {
  return {
    async mappingBySource(projectId) {
      const projectOid = oid(projectId);
      const [suggestions, decisions] = await Promise.all([
        MappingSuggestionModel.aggregate<{
          _id: Types.ObjectId;
          columns: number;
          schemaVersion: number;
          rulesOnly: number;
        }>([
          { $match: { projectId: projectOid } },
          {
            $group: {
              _id: '$sourceId',
              columns: { $sum: 1 },
              schemaVersion: { $max: '$schemaVersion' },
              // A mapping run rewrites every column of the source, so all share one method.
              rulesOnly: { $max: { $cond: [{ $eq: ['$method', 'rules'] }, 1, 0] } },
            },
          },
        ]),
        MappingDecisionModel.aggregate<{ _id: Types.ObjectId; count: number }>([
          { $match: { projectId: projectOid } },
          { $group: { _id: '$sourceId', count: { $sum: 1 } } },
        ]),
      ]);
      const decided = new Map(decisions.map((d) => [d._id.toHexString(), d.count]));
      return suggestions.map((s) => ({
        sourceId: s._id.toHexString(),
        columns: s.columns,
        decisions: decided.get(s._id.toHexString()) ?? 0,
        schemaVersion: s.schemaVersion,
        rulesOnly: s.rulesOnly === 1,
      }));
    },

    async mappingDecisionLagsMs(projectId, since) {
      const projectOid = oid(projectId);
      const rows = await MappingDecisionModel.aggregate<{ ms: number }>([
        { $match: { projectId: projectOid, decidedAt: { $gte: since } } },
        {
          $lookup: {
            from: 'mapping_suggestions',
            let: { sourceId: '$sourceId', column: '$column' },
            pipeline: [
              {
                $match: {
                  projectId: projectOid,
                  $expr: {
                    $and: [{ $eq: ['$sourceId', '$$sourceId'] }, { $eq: ['$column', '$$column'] }],
                  },
                },
              },
              { $project: { _id: 0, createdAt: 1 } },
            ],
            as: 'suggestion',
          },
        },
        { $unwind: '$suggestion' },
        { $project: { _id: 0, ms: { $subtract: ['$decidedAt', '$suggestion.createdAt'] } } },
        { $match: { ms: { $gte: 0 } } },
        { $sort: { ms: 1 } },
      ]);
      return rows.map((r) => r.ms);
    },

    async countExports(projectId) {
      return ExportModel.countDocuments({ projectId: oid(projectId) });
    },

    async auditCounts(projectId, since, actions) {
      const rows = await AuditLogModel.aggregate<{
        _id: { action: string; decision?: string | null; actorId: string };
        count: number;
      }>([
        {
          $match: {
            projectId: oid(projectId),
            createdAt: { $gte: since },
            action: { $in: actions },
          },
        },
        {
          $group: {
            _id: {
              action: '$action',
              decision: {
                $cond: [{ $eq: ['$action', 'mapping.decide'] }, '$after.decision', null],
              },
              actorId: '$actorId',
            },
            count: { $sum: 1 },
          },
        },
      ]);
      return rows.map((r): AuditCount => ({
        action: r._id.action,
        decision: r._id.decision ?? null,
        actorId: r._id.actorId,
        count: r.count,
      }));
    },

    async jobStats(projectId, since) {
      const [facets] = await JobModel.aggregate<JobFacets>([
        { $match: { projectId: oid(projectId), createdAt: { $gte: since } } },
        {
          $facet: {
            counts: [
              {
                $group: {
                  _id: { type: '$type', status: '$status', code: '$error.code' },
                  count: { $sum: 1 },
                },
              },
            ],
            durations: [
              {
                $match: {
                  status: 'succeeded',
                  startedAt: { $ne: null },
                  finishedAt: { $ne: null },
                },
              },
              { $project: { type: 1, ms: { $subtract: ['$finishedAt', '$startedAt'] } } },
              { $sort: { ms: 1 } },
              { $group: { _id: '$type', ms: { $push: '$ms' } } },
            ],
            failures: [
              { $match: { status: 'failed' } },
              { $addFields: { at: { $ifNull: ['$finishedAt', '$updatedAt'] } } },
              { $sort: { at: -1, _id: -1 } },
              { $limit: 5 },
              { $project: { _id: 0, type: 1, code: '$error.code', at: 1 } },
            ],
          },
        },
      ]);
      return {
        counts: (facets?.counts ?? []).map((c) => ({
          type: c._id.type,
          status: c._id.status,
          errorCode: c._id.code ?? null,
          count: c.count,
        })),
        durations: (facets?.durations ?? []).map((d) => ({ type: d._id, durationsMs: d.ms })),
        failures: (facets?.failures ?? []).map((f) => ({
          type: f.type,
          code: f.code ?? null,
          at: f.at,
        })),
      };
    },

    async llmStats(projectId, since) {
      const isTrue = (field: string) => ({ $cond: [{ $eq: [field, true] }, 1, 0] });
      const [facets] = await LlmCallModel.aggregate<LlmFacets>([
        { $match: { project_id: projectId, created_at: { $gte: since } } },
        {
          $facet: {
            tasks: [
              {
                $group: {
                  _id: '$task',
                  calls: { $sum: 1 },
                  ok: { $sum: { $cond: [{ $eq: ['$outcome', 'ok'] }, 1, 0] } },
                  cacheHits: { $sum: isTrue('$cache_hit') },
                  schemaFallbacks: { $sum: isTrue('$schema_fallback') },
                  inputTokens: { $sum: '$input_tokens' },
                  outputTokens: { $sum: '$output_tokens' },
                  costInr: { $sum: '$cost_inr' },
                  models: { $addToSet: '$model' },
                },
              },
            ],
            latencies: [
              { $match: { outcome: 'ok', cache_hit: { $ne: true } } },
              { $sort: { latency_ms: 1 } },
              { $group: { _id: '$task', ms: { $push: '$latency_ms' } } },
            ],
            errors: [
              { $match: { outcome: 'error' } },
              {
                $group: {
                  _id: {
                    task: '$task',
                    status: '$error_status',
                    code: '$error_code',
                    type: '$error_type',
                  },
                  count: { $sum: 1 },
                },
              },
            ],
            days: [
              {
                $group: {
                  _id: { $dateToString: { format: '%Y-%m-%d', date: '$created_at' } },
                  calls: { $sum: 1 },
                  tokens: { $sum: { $add: ['$input_tokens', '$output_tokens'] } },
                  costInr: { $sum: '$cost_inr' },
                },
              },
            ],
          },
        },
      ]);
      const latencies = new Map((facets?.latencies ?? []).map((l) => [l._id, l.ms]));
      return {
        tasks: (facets?.tasks ?? []).map(({ _id, models, ...totals }) => ({
          task: _id,
          ...totals,
          models: [...models].sort(),
          latenciesMs: latencies.get(_id) ?? [],
        })),
        errors: (facets?.errors ?? []).map((e): LlmErrorCount => ({
          task: e._id.task,
          status: e._id.status ?? null,
          httpCode: e._id.code ?? null,
          errorType: e._id.type ?? null,
          count: e.count,
        })),
        days: (facets?.days ?? []).map(({ _id, ...day }) => ({ date: _id, ...day })),
      };
    },

    async qualitySeries(projectId, since, limit) {
      const docs = await QualityRunModel.find(
        { projectId: oid(projectId), startedAt: { $gte: since } },
        { startedAt: 1, status: 1, statusCounts: 1 },
      )
        .sort({ startedAt: -1, _id: -1 })
        .limit(limit)
        .lean<
          {
            startedAt: Date;
            status: QualityPoint['status'];
            statusCounts?: Partial<Record<'pass' | 'warn' | 'fail', number>>;
          }[]
        >();
      return docs.reverse().map((d) => ({
        at: d.startedAt,
        status: d.status,
        pass: d.statusCounts?.pass ?? 0,
        warn: d.statusCounts?.warn ?? 0,
        fail: d.statusCounts?.fail ?? 0,
      }));
    },
  };
}
