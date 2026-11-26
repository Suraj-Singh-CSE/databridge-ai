import type { AiBudget } from '../../ai-service.client.js';
import type { Repositories } from '../../repositories.js';
import { candidatesOutdated } from '../candidates/candidate.service.js';
import type { ClusterApproval, ClusterSummary } from '../clusters/cluster.types.js';
import { JOB_TYPES, type JobType } from '../jobs/job.types.js';
import type { Project, ProjectRole, ProjectStep } from '../projects/project.types.js';
import type { QualityStatus } from '../quality/quality.types.js';
import type { ScoreBand } from '../scores/score.types.js';
import type { SqlMethod, SqlStatus, SqlVersion } from '../sql/sql.types.js';
import { SOURCE_STATUSES, type Source, type SourceStatus } from '../sources/source.types.js';

import { BENCHMARKS, type Benchmarks } from './benchmarks.js';
import { daysBetween, percentile, round2 } from './dashboard.stats.js';
import {
  DASHBOARD_RANGES,
  type DashboardRange,
  type MappingSourceCounts,
} from './dashboard.types.js';

/* ---------- Response ---------- */

export interface NextStep {
  /** Plain words for the person, e.g. "Approve the mapping for billing_export.xlsx". */
  text: string;
  step: ProjectStep;
}

export interface PipelineView {
  sources: { count: number; byStatus: Record<SourceStatus, number>; rowsUploaded: number };
  mapping: {
    sourcesMapped: number;
    columns: number;
    decided: number;
    pending: number;
    /** Sources whose newest mapping run fell back to the rules (no LLM answer). */
    sourcesOnRules: number;
    /** The target schema changed after some sources' suggestions were made. */
    outdated: boolean;
  };
  standardise: {
    sources: number;
    rows: number;
    rowsWithIssues: number;
    /** A source changed (re-profiled) after it was standardised. */
    outdated: boolean;
  };
  candidates: { ran: boolean; pairs: number; outdated: boolean };
  scores: { ran: boolean; pairs: number; byBand: Record<ScoreBand, number>; outdated: boolean };
  aiReview: { ran: boolean; pairs: number; reviewed: number; unavailable: number };
  clusters: {
    ran: boolean;
    customers: number;
    multiRecord: number;
    /** Records folded into another record's customer: records - customers. */
    recordsMerged: number;
    needsReview: number;
    approved: number;
    proposed: number;
    outdated: boolean;
  };
  sql: {
    latest: { version: number; status: SqlStatus; testsPassed: boolean; method: SqlMethod } | null;
    approvedVersion: number | null;
    /** The latest version was drafted from an older clustering run. */
    outdated: boolean;
  };
  exports: { count: number; outdated: boolean };
  quality: {
    latest: { status: Exclude<QualityStatus, 'skipped'>; at: Date } | null;
    outdated: boolean;
  };
  nextStep: NextStep;
}

export interface QualityView {
  runs: {
    at: Date;
    status: Exclude<QualityStatus, 'skipped'>;
    pass: number;
    warn: number;
    fail: number;
  }[];
  latestRules: {
    rule: string;
    field: string | null;
    label: string;
    status: QualityStatus;
    metric: number | null;
    unit: 'percent' | 'hours';
  }[];
}

export interface AiTaskView {
  task: string;
  calls: number;
  ok: number;
  failed: number;
  failedBy: {
    status: string | null;
    httpCode: number | null;
    errorType: string | null;
    count: number;
  }[];
  cacheHits: number;
  schemaFallbacks: number;
  inputTokens: number;
  outputTokens: number;
  costInr: number;
  /** `free tier` when nothing was billed (the configured prices are 0). */
  costLabel: 'free tier' | 'paid';
  /** Successful calls the provider answered (cache hits excluded); null when there were none. */
  latencyMs: { p50: number | null; p95: number | null; samples: number };
  models: string[];
}

export interface AiView {
  tasks: AiTaskView[];
  total: Omit<AiTaskView, 'task'>;
  /** Fallbacks to the deterministic path, from the modules' own records (not llm_calls). */
  fallbacks: {
    mappingSourcesOnRules: number;
    sqlReferenceVersions: number;
    pairReviewUnavailable: number;
  };
  daily: { date: string; calls: number; tokens: number; costInr: number }[];
  /**
   * Today's shared LLM request budget (ADR 0028): `remainingToday` is what this project may
   * still send today. Null when the ai-service keeps no daily cap or could not be asked.
   */
  budget: {
    dailyLimit: number | null;
    usedToday: number;
    projectDailyLimit: number | null;
    projectUsedToday: number;
    remainingToday: number | null;
    resetsAt: string;
  } | null;
}

/** Reads today's LLM budget for a project (the ai-service's `/llm/budget`). */
export type BudgetReader = (projectId: string, requestId: string) => Promise<AiBudget | null>;

export const REVIEW_TYPES = [
  'mapping_accept',
  'mapping_reject',
  'mapping_override',
  'mapping_accept_high',
  'match_approve',
  'match_approve_high',
  'match_split',
  'match_merge',
  'match_undo',
  'sql_approve',
  'sql_reject',
  'quality_rules_change',
] as const;
export type ReviewType = (typeof REVIEW_TYPES)[number];

/** A person's relation to the project when the dashboard is read (never a name). */
export type ReviewerRole = 'owner' | ProjectRole | 'admin' | 'former_member';

export interface ReviewView {
  total: number;
  byType: Record<ReviewType, number>;
  byRole: Partial<Record<ReviewerRole, number>>;
  /** Suggestion to decision, where both times are stored; a key is absent when not computable. */
  medianTimeToDecisionMs: Partial<
    Record<'mapping' | 'match_approve' | 'sql', { medianMs: number; samples: number }>
  >;
}

export interface JobTypeView {
  type: JobType;
  total: number;
  succeeded: number;
  failed: number;
  failedBy: { code: string; count: number }[];
  cancelled: number;
  active: number;
  /** Succeeded jobs, startedAt to finishedAt. */
  durationMs: { median: number | null; p95: number | null };
}

export interface JobsView {
  byType: JobTypeView[];
  recentFailures: { type: JobType; code: string | null; at: Date }[];
}

export interface Dashboard {
  range: { key: DashboardRange; days: number; since: Date; until: Date };
  pipeline: PipelineView;
  quality: QualityView;
  ai: AiView;
  review: ReviewView;
  jobs: JobsView;
  benchmarks: Benchmarks;
}

export interface DashboardService {
  /** `requestId` is passed on to the ai-service when the budget is read. */
  get(project: Project, range: DashboardRange, requestId?: string): Promise<Dashboard>;
}

/* ---------- Building blocks ---------- */

const REVIEW_ACTIONS: Record<
  string,
  ReviewType | ((decision: string | null) => ReviewType | null)
> = {
  'mapping.decide': (decision) =>
    decision === 'accept'
      ? 'mapping_accept'
      : decision === 'reject'
        ? 'mapping_reject'
        : decision === 'override'
          ? 'mapping_override'
          : null,
  'mapping.accept_high': 'mapping_accept_high',
  'cluster.approve': 'match_approve',
  'cluster.approve_high': 'match_approve_high',
  'cluster.split': 'match_split',
  'cluster.merge': 'match_merge',
  'cluster.unapprove': 'match_undo',
  'sql_version.approve': 'sql_approve',
  'sql_version.reject': 'sql_reject',
  'quality_rules.update': 'quality_rules_change',
};

const QUALITY_SERIES_LIMIT = 500;

function zeroes<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
}

function medianOf(values: number[]): { medianMs: number; samples: number } | undefined {
  const sorted = [...values].sort((a, b) => a - b);
  const median = percentile(sorted, 0.5);
  return median === null ? undefined : { medianMs: Math.round(median), samples: sorted.length };
}

interface PipelineInputs {
  sources: Source[];
  mapping: MappingSourceCounts[];
  schemaVersion: number | null;
  candidates: Awaited<ReturnType<Repositories['candidates']['findSummary']>>;
  scores: Awaited<ReturnType<Repositories['scores']['findSummary']>>;
  clusters: ClusterSummary | null;
  approved: number;
  sqlLatest: SqlVersion | undefined;
  sqlApproved: number | null;
  exportCount: number;
  latestExportRunId: string | null;
  qualityLatest: Awaited<ReturnType<Repositories['quality']['latestRun']>>;
}

function nextStepOf(p: Omit<PipelineView, 'nextStep'>, inputs: PipelineInputs): NextStep {
  const { sources, mapping } = inputs;
  if (sources.length === 0) return { text: 'Upload your first file', step: 'sources' };
  const failed = sources.find((s) => s.status === 'failed');
  if (failed)
    return { text: `Fix or replace ${failed.name}: it could not be read`, step: 'sources' };
  const unprofiled = sources.find((s) => s.status === 'uploaded' || s.status === 'profiling');
  if (unprofiled) return { text: `Profile ${unprofiled.name}`, step: 'profile' };
  const bySource = new Map(mapping.map((m) => [m.sourceId, m]));
  const unmapped = sources.find((s) => !bySource.has(s.id));
  if (unmapped) return { text: `Run the mapping for ${unmapped.name}`, step: 'mapping' };
  const stale = sources.find(
    (s) =>
      inputs.schemaVersion !== null && bySource.get(s.id)?.schemaVersion !== inputs.schemaVersion,
  );
  if (stale)
    return {
      text: `Run the mapping for ${stale.name} again: the target schema changed`,
      step: 'mapping',
    };
  const pending = sources.find((s) => {
    const m = bySource.get(s.id);
    return m !== undefined && m.decisions < m.columns;
  });
  if (pending) return { text: `Approve the mapping for ${pending.name}`, step: 'mapping' };
  const unstandardised = sources.find((s) => s.status !== 'standardised');
  if (unstandardised) return { text: `Standardise ${unstandardised.name}`, step: 'mapping' };
  if (!p.candidates.ran || p.candidates.outdated)
    return { text: 'Find candidate pairs', step: 'matching' };
  if (!p.scores.ran || p.scores.outdated)
    return { text: 'Score the candidate pairs', step: 'matching' };
  if (!p.clusters.ran || p.clusters.outdated) return { text: 'Build clusters', step: 'matching' };
  if (p.clusters.needsReview > 0 && p.clusters.approved === 0) {
    return {
      text: `Review the ${p.clusters.needsReview} customers that need a look`,
      step: 'matching',
    };
  }
  if (p.clusters.approved === 0)
    return { text: 'Approve customers in Match Review', step: 'matching' };
  if (p.sql.approvedVersion === null || p.sql.outdated) {
    return { text: 'Draft, test and approve the SQL', step: 'pipeline' };
  }
  if (!p.quality.latest || p.quality.outdated)
    return { text: 'Run the quality check', step: 'quality' };
  if (p.quality.latest.status === 'fail')
    return { text: 'Fix the failing quality rules', step: 'quality' };
  if (p.exports.count === 0 || p.exports.outdated)
    return { text: 'Export the golden records', step: 'pipeline' };
  return { text: 'Everything is up to date', step: 'quality' };
}

function pipelineOf(inputs: PipelineInputs): PipelineView {
  const { sources, mapping, candidates, scores, clusters } = inputs;
  const byStatus = zeroes(SOURCE_STATUSES);
  for (const s of sources) byStatus[s.status] += 1;
  const standardised = sources.filter((s) => s.status === 'standardised' && s.standardisation);
  const columns = mapping.reduce((sum, m) => sum + m.columns, 0);
  const decided = mapping.reduce((sum, m) => sum + Math.min(m.decisions, m.columns), 0);

  const candidatesOld = candidates ? candidatesOutdated(candidates, sources) : false;
  const scoresOld = scores ? candidates?.runId !== scores.candidatesRunId || candidatesOld : false;
  const clustersOld = clusters
    ? scores?.runId !== clusters.scoresRunId ||
      (scores.aiReview?.jobId ?? null) !== clusters.aiReviewJobId ||
      scoresOld
    : false;
  const currentRun = clusters && !clustersOld ? clusters.runId : null;
  const bands = zeroes<ScoreBand>(['match', 'maybe', 'non_match']);
  for (const b of scores?.bandCounts ?? []) bands[b.band] = b.count;
  const ai = scores?.aiReview ?? null;

  const view: Omit<PipelineView, 'nextStep'> = {
    sources: {
      count: sources.length,
      byStatus,
      rowsUploaded: sources.reduce((sum, s) => sum + (s.rowCount ?? 0), 0),
    },
    mapping: {
      sourcesMapped: mapping.length,
      columns,
      decided,
      pending: columns - decided,
      sourcesOnRules: mapping.filter((m) => m.rulesOnly).length,
      outdated:
        inputs.schemaVersion !== null &&
        mapping.some((m) => m.schemaVersion !== inputs.schemaVersion),
    },
    standardise: {
      sources: standardised.length,
      rows: standardised.reduce((sum, s) => sum + (s.standardisation?.rowCount ?? 0), 0),
      rowsWithIssues: standardised.reduce(
        (sum, s) => sum + (s.standardisation?.rowsWithIssues ?? 0),
        0,
      ),
      outdated: sources.some((s) => s.standardisation !== null && s.status !== 'standardised'),
    },
    candidates: {
      ran: candidates !== null,
      pairs: candidates?.pairCount ?? 0,
      outdated: candidatesOld,
    },
    scores: {
      ran: scores !== null,
      pairs: scores?.pairCount ?? 0,
      byBand: bands,
      outdated: scoresOld,
    },
    aiReview: {
      ran: ai !== null,
      pairs: ai?.pairCount ?? 0,
      reviewed: ai?.reviewed ?? 0,
      unavailable: ai?.unavailable ?? 0,
    },
    clusters: {
      ran: clusters !== null,
      customers: clusters?.clusterCount ?? 0,
      multiRecord: clusters?.multiRecordCount ?? 0,
      recordsMerged: clusters ? clusters.recordCount - clusters.clusterCount : 0,
      needsReview: clusters?.needsReviewCount ?? 0,
      approved: inputs.approved,
      proposed: clusters ? clusters.clusterCount - inputs.approved : 0,
      outdated: clustersOld,
    },
    sql: {
      latest: inputs.sqlLatest
        ? {
            version: inputs.sqlLatest.version,
            status: inputs.sqlLatest.status,
            testsPassed: inputs.sqlLatest.testsPassed,
            method: inputs.sqlLatest.method,
          }
        : null,
      approvedVersion: inputs.sqlApproved,
      outdated: inputs.sqlLatest !== undefined && inputs.sqlLatest.clusteringRunId !== currentRun,
    },
    exports: {
      count: inputs.exportCount,
      outdated: inputs.latestExportRunId !== null && inputs.latestExportRunId !== currentRun,
    },
    quality: {
      latest: inputs.qualityLatest
        ? { status: inputs.qualityLatest.status, at: inputs.qualityLatest.startedAt }
        : null,
      outdated:
        inputs.qualityLatest !== null && inputs.qualityLatest.clusteringRunId !== currentRun,
    },
  };
  return { ...view, nextStep: nextStepOf(view, inputs) };
}

function emptyTask(): Omit<AiTaskView, 'task'> {
  return {
    calls: 0,
    ok: 0,
    failed: 0,
    failedBy: [],
    cacheHits: 0,
    schemaFallbacks: 0,
    inputTokens: 0,
    outputTokens: 0,
    costInr: 0,
    costLabel: 'free tier',
    latencyMs: { p50: null, p95: null, samples: 0 },
    models: [],
  };
}

/* ---------- Service ---------- */

export function createDashboardService(
  repos: Pick<
    Repositories,
    | 'sources'
    | 'targetSchemas'
    | 'candidates'
    | 'scores'
    | 'clusters'
    | 'review'
    | 'sqlVersions'
    | 'exports'
    | 'quality'
    | 'users'
    | 'dashboard'
  >,
  now: () => Date = () => new Date(),
  readBudget: BudgetReader = () => Promise.resolve(null),
): DashboardService {
  /** Best effort: a sleeping or failing ai-service leaves the budget unknown (null). */
  async function budgetOf(project: Project, requestId: string): Promise<AiView['budget']> {
    try {
      const budget = await readBudget(project.id, requestId);
      if (!budget) return null;
      const { provider: _provider, model: _model, ...counts } = budget;
      return counts;
    } catch {
      return null;
    }
  }

  async function rolesOf(project: Project, actorIds: string[]): Promise<Map<string, ReviewerRole>> {
    const roles = new Map<string, ReviewerRole>();
    const others: string[] = [];
    for (const id of actorIds) {
      const member = project.members.find((m) => m.userId === id);
      if (project.ownerId === id) roles.set(id, 'owner');
      else if (member) roles.set(id, member.role);
      else others.push(id);
    }
    // Only people who acted in the project but are not in it now (admins, removed members).
    const users = await Promise.all(others.map((id) => repos.users.findById(id)));
    others.forEach((id, i) =>
      roles.set(id, users[i]?.role === 'admin' ? 'admin' : 'former_member'),
    );
    return roles;
  }

  async function reviewOf(
    project: Project,
    since: Date,
    clusters: ClusterSummary | null,
    approvals: ClusterApproval[],
    sqlVersions: SqlVersion[],
  ): Promise<ReviewView> {
    const [counts, mappingLags] = await Promise.all([
      repos.dashboard.auditCounts(project.id, since, Object.keys(REVIEW_ACTIONS)),
      repos.dashboard.mappingDecisionLagsMs(project.id, since),
    ]);
    const roles = await rolesOf(project, [...new Set(counts.map((c) => c.actorId))]);
    const byType = zeroes(REVIEW_TYPES);
    const byRole: Partial<Record<ReviewerRole, number>> = {};
    let total = 0;
    for (const c of counts) {
      const rule = REVIEW_ACTIONS[c.action];
      const type = typeof rule === 'function' ? rule(c.decision) : rule;
      if (!type) continue;
      byType[type] += c.count;
      const role = roles.get(c.actorId) ?? 'former_member';
      byRole[role] = (byRole[role] ?? 0) + c.count;
      total += c.count;
    }

    const medians: ReviewView['medianTimeToDecisionMs'] = {};
    const mapping = medianOf(mappingLags);
    if (mapping) medians.mapping = mapping;
    // Approvals of the current run: from the clusters being proposed to the approval.
    const approvalLags = approvals.flatMap((a) => {
      if (a.runId !== clusters?.runId || a.approvedAt < since) return [];
      const ms = a.approvedAt.getTime() - clusters.finishedAt.getTime();
      return ms >= 0 ? [ms] : [];
    });
    const match = medianOf(approvalLags);
    if (match) medians.match_approve = match;
    const sqlLags = sqlVersions.flatMap((v) => {
      const decidedAt = v.approvedAt ?? v.rejectedAt;
      const ms = decidedAt ? decidedAt.getTime() - v.createdAt.getTime() : -1;
      return decidedAt && decidedAt >= since && ms >= 0 ? [ms] : [];
    });
    const sql = medianOf(sqlLags);
    if (sql) medians.sql = sql;
    return { total, byType, byRole, medianTimeToDecisionMs: medians };
  }

  async function aiOf(
    project: Project,
    since: Date,
    until: Date,
    fallbacks: AiView['fallbacks'],
    requestId: string,
  ): Promise<AiView> {
    const [stats, budget] = await Promise.all([
      repos.dashboard.llmStats(project.id, since),
      budgetOf(project, requestId),
    ]);
    const tasks = stats.tasks
      .map((t): AiTaskView => {
        const failedBy = stats.errors
          .filter((e) => e.task === t.task)
          .map(({ task: _task, ...e }) => e)
          .sort((a, b) => b.count - a.count);
        return {
          task: t.task,
          calls: t.calls,
          ok: t.ok,
          failed: t.calls - t.ok,
          failedBy,
          cacheHits: t.cacheHits,
          schemaFallbacks: t.schemaFallbacks,
          inputTokens: t.inputTokens,
          outputTokens: t.outputTokens,
          costInr: round2(t.costInr),
          costLabel: t.costInr > 0 ? 'paid' : 'free tier',
          latencyMs: {
            p50: percentile(t.latenciesMs, 0.5),
            p95: percentile(t.latenciesMs, 0.95),
            samples: t.latenciesMs.length,
          },
          models: t.models,
        };
      })
      .sort((a, b) => a.task.localeCompare(b.task));

    const total = emptyTask();
    const allLatencies = stats.tasks.flatMap((t) => t.latenciesMs).sort((a, b) => a - b);
    const failedBy = new Map<string, AiTaskView['failedBy'][number]>();
    for (const t of tasks) {
      total.calls += t.calls;
      total.ok += t.ok;
      total.failed += t.failed;
      total.cacheHits += t.cacheHits;
      total.schemaFallbacks += t.schemaFallbacks;
      total.inputTokens += t.inputTokens;
      total.outputTokens += t.outputTokens;
      total.costInr += t.costInr;
      for (const e of t.failedBy) {
        const key = `${e.status ?? ''}|${e.httpCode ?? ''}|${e.errorType ?? ''}`;
        const found = failedBy.get(key);
        if (found) found.count += e.count;
        else failedBy.set(key, { ...e });
      }
    }
    total.failedBy = [...failedBy.values()].sort((a, b) => b.count - a.count);
    total.costInr = round2(total.costInr);
    total.costLabel = total.costInr > 0 ? 'paid' : 'free tier';
    total.models = [...new Set(tasks.flatMap((t) => t.models))].sort();
    total.latencyMs = {
      p50: percentile(allLatencies, 0.5),
      p95: percentile(allLatencies, 0.95),
      samples: allLatencies.length,
    };

    const byDay = new Map(stats.days.map((d) => [d.date, d]));
    const daily = daysBetween(since, until).map((date) => {
      const d = byDay.get(date);
      return {
        date,
        calls: d?.calls ?? 0,
        tokens: d?.tokens ?? 0,
        costInr: round2(d?.costInr ?? 0),
      };
    });
    return { tasks, total, fallbacks, daily, budget };
  }

  async function jobsOf(project: Project, since: Date): Promise<JobsView> {
    const stats = await repos.dashboard.jobStats(project.id, since);
    const durations = new Map(stats.durations.map((d) => [d.type, d.durationsMs]));
    const byType = JOB_TYPES.flatMap((type): JobTypeView[] => {
      const rows = stats.counts.filter((c) => c.type === type);
      if (rows.length === 0) return [];
      const sum = (status: string) =>
        rows.filter((r) => r.status === status).reduce((n, r) => n + r.count, 0);
      const failedBy = new Map<string, number>();
      for (const r of rows.filter((x) => x.status === 'failed')) {
        const code = r.errorCode ?? 'UNKNOWN';
        failedBy.set(code, (failedBy.get(code) ?? 0) + r.count);
      }
      const ms = durations.get(type) ?? [];
      return [
        {
          type,
          total: rows.reduce((n, r) => n + r.count, 0),
          succeeded: sum('succeeded'),
          failed: sum('failed'),
          failedBy: [...failedBy]
            .map(([code, count]) => ({ code, count }))
            .sort((a, b) => b.count - a.count),
          cancelled: sum('cancelled'),
          active: sum('queued') + sum('running'),
          durationMs: { median: percentile(ms, 0.5), p95: percentile(ms, 0.95) },
        },
      ];
    });
    return { byType, recentFailures: stats.failures };
  }

  return {
    async get(project, range, requestId = 'dashboard') {
      const until = now();
      const days = DASHBOARD_RANGES[range];
      const since = new Date(until.getTime() - days * 86_400_000);
      const [
        sources,
        mapping,
        schema,
        candidates,
        scores,
        clusters,
        sqlVersions,
        sqlApproved,
        exportCount,
        latestExports,
        qualityLatest,
        qualitySeries,
        jobs,
      ] = await Promise.all([
        repos.sources.listByProject(project.id),
        repos.dashboard.mappingBySource(project.id),
        repos.targetSchemas.findByProject(project.id),
        repos.candidates.findSummary(project.id),
        repos.scores.findSummary(project.id),
        repos.clusters.findSummary(project.id),
        repos.sqlVersions.listByProject(project.id, 100),
        repos.sqlVersions.findApproved(project.id),
        repos.dashboard.countExports(project.id),
        repos.exports.listByProject(project.id, 1),
        repos.quality.latestRun(project.id),
        repos.dashboard.qualitySeries(project.id, since, QUALITY_SERIES_LIMIT),
        jobsOf(project, since),
      ]);
      // Approved = an approval exists for the exact membership of a current cluster (ADR 0019).
      const approvals = clusters ? await repos.review.listApprovals(project.id) : [];
      const approved = clusters
        ? await repos.clusters.countWithIds(
            project.id,
            clusters.runId,
            approvals.map((a) => a.customerId),
          )
        : 0;
      const pipeline = pipelineOf({
        sources,
        mapping,
        schemaVersion: schema?.version ?? null,
        candidates,
        scores,
        clusters,
        approved,
        sqlLatest: sqlVersions[0],
        sqlApproved: sqlApproved?.version ?? null,
        exportCount,
        latestExportRunId: latestExports[0]?.clusteringRunId ?? null,
        qualityLatest,
      });
      const [ai, review] = await Promise.all([
        aiOf(
          project,
          since,
          until,
          {
            mappingSourcesOnRules: pipeline.mapping.sourcesOnRules,
            sqlReferenceVersions: sqlVersions.filter((v) => v.method === 'reference').length,
            pairReviewUnavailable: pipeline.aiReview.unavailable,
          },
          requestId,
        ),
        reviewOf(project, since, clusters, approvals, sqlVersions),
      ]);
      return {
        range: { key: range, days, since, until },
        pipeline,
        quality: {
          runs: qualitySeries,
          latestRules: (qualityLatest?.results ?? []).map((r) => ({
            rule: r.rule,
            field: r.field,
            label: r.label,
            status: r.status,
            metric: r.metric,
            unit: r.unit,
          })),
        },
        ai,
        review,
        jobs,
        benchmarks: BENCHMARKS,
      };
    },
  };
}
