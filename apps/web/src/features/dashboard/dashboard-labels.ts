import type { DashboardRange, JobType, ReviewerRole, ReviewType } from '@/lib/api-types';

export const RANGE_LABELS: Record<DashboardRange, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
};

export const JOB_TYPE_LABELS: Record<JobType, string> = {
  demo: 'Demo',
  profile: 'Profile a file',
  mapping: 'Suggest column mapping',
  standardise: 'Standardise values',
  candidates: 'Find possible duplicates',
  scoring: 'Score pairs',
  pair_review: 'AI review of pairs',
  clustering: 'Group into customers',
  export: 'Export',
  sql_draft: 'Draft SQL',
  sql_run: 'Test SQL',
  quality: 'Quality checks',
  knowledge_index: 'Build project knowledge',
};

export const REVIEW_TYPE_LABELS: Record<ReviewType, string> = {
  mapping_accept: 'Mapping accepted',
  mapping_reject: 'Mapping rejected',
  mapping_override: 'Mapping changed by hand',
  mapping_accept_high: 'High-confidence mappings accepted together',
  match_approve: 'Customer approved',
  match_approve_high: 'High-confidence customers approved together',
  match_split: 'Records split apart',
  match_merge: 'Records merged by hand',
  match_undo: 'Decision undone',
  sql_approve: 'SQL approved',
  sql_reject: 'SQL rejected',
  quality_rules_change: 'Quality rules changed',
};

export const REVIEWER_ROLE_LABELS: Record<ReviewerRole, string> = {
  owner: 'Project owner',
  admin: 'Admin',
  data_engineer: 'Data engineer',
  data_steward: 'Data steward',
  viewer: 'Viewer',
  former_member: 'Former member',
};

export const DECISION_LAG_LABELS = {
  mapping: 'Column mapping',
  match_approve: 'Customer approval',
  sql: 'SQL review',
} as const;

/** AI tasks the gateway logs (apps/ai-service), in plain words; unknown tasks keep their id. */
const AI_TASK_LABELS: Record<string, string> = {
  mapping: 'Column mapping',
  pair_review: 'Pair review',
  sql_draft: 'SQL drafting',
  assistant: 'Assistant',
};

export function aiTaskLabel(task: string): string {
  return AI_TASK_LABELS[task] ?? sentence(task);
}

const ERROR_CODE_LABELS: Record<string, string> = {
  HTTP_TIMEOUT: 'The AI service took too long to answer',
  QUEUE_UNAVAILABLE: 'The job queue was not available',
  SOURCE_NOT_FOUND: 'The file was deleted',
  UNSUPPORTED_FILE: 'The file type is not supported',
  CANDIDATES_OUTDATED: 'Possible duplicates were out of date',
  SCORES_OUTDATED: 'Pair scores were out of date',
  SCORES_CHANGED: 'Pair scores changed while it ran',
  MAPPING_NOT_RUN: 'The column mapping had not been made',
  CANDIDATES_NOT_RUN: 'Possible duplicates had not been found',
  SQL_NOT_READ_ONLY: 'The SQL tried to change data',
  SQL_VERSION_NOT_FOUND: 'The SQL version was not found',
};

/** "SOME_CODE" -> "Some code". */
function sentence(id: string): string {
  const words = id.toLowerCase().replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function errorCodeText(code: string | null): string {
  if (code === null) return 'No reason recorded';
  return ERROR_CODE_LABELS[code] ?? sentence(code);
}

/** Benchmark metric ids (apps/api benchmarks.ts) in plain words; unknown ids keep their id. */
const METRIC_LABELS: Record<string, string> = {
  rules_accuracy: 'Accuracy, rules only',
  hybrid_accuracy: 'Accuracy, rules + AI',
  rules_accuracy_at_high: 'Accuracy at high confidence, rules only',
  hybrid_accuracy_at_high: 'Accuracy at high confidence, rules + AI',
  pair_completeness: 'True pairs kept',
  reduction_ratio: 'Comparisons avoided',
  pairs_quality: 'Kept pairs that are true',
  precision: 'Precision',
  recall: 'Recall',
  f1: 'F1 score',
  false_matches: 'Wrong matches',
  people_exactly_rebuilt: 'People rebuilt exactly',
  pairwise_precision: 'Pairwise precision',
  over_merged_clusters: 'Customers wrongly merged',
  detection_precision: 'Detection precision',
  detection_recall: 'Detection recall',
  malicious_queries_refused: 'Malicious queries refused',
};

export function metricLabel(name: string): string {
  return METRIC_LABELS[name] ?? sentence(name);
}

/** "docs/adr/0016-pair-scoring.md" -> "ADR 0016". */
export function adrLabel(source: string): string {
  const match = /(\d{4})-[^/]*\.md$/.exec(source);
  return match ? `ADR ${match[1]}` : source;
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** "412 ms", "2.5 s", "3.2 min", "5.1 h", "2.0 days"; an em dash when nothing was measured. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const units: [number, string][] = [
    [86_400_000, 'days'],
    [3_600_000, 'h'],
    [60_000, 'min'],
    [1000, 's'],
  ];
  for (const [size, unit] of units) {
    if (ms >= size) return `${(ms / size).toFixed(1)} ${unit}`;
  }
  return `${ms} ms`;
}

/** "₹0 (free tier)" when nothing was billed; otherwise the rupee amount. */
export function formatCost(costInr: number): string {
  if (costInr === 0) return '₹0 (free tier)';
  return `₹${costInr.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}
