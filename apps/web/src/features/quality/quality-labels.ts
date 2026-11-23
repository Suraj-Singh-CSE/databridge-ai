import type { StatusTone } from '@/components/StatusPill';
import type { QualityResult, QualityStatus, QualityThreshold } from '@/lib/api-types';

export const QUALITY_STATUS: Record<QualityStatus, { label: string; tone: StatusTone }> = {
  pass: { label: 'Pass', tone: 'high' },
  warn: { label: 'Warning', tone: 'review' },
  fail: { label: 'Fail', tone: 'low' },
  skipped: { label: 'Skipped', tone: 'neutral' },
};

export const RULE_KINDS = [
  'Completeness',
  'Validity',
  'Uniqueness',
  'Consistency',
  'Freshness',
  'Volume',
] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

/** The rule ids of apps/ai-service app/quality/config.py, by the kind of check they make. */
const KIND_OF_RULE: Record<string, RuleKind> = {
  completeness_required: 'Completeness',
  completeness_optional: 'Completeness',
  validity: 'Validity',
  customer_id_unique: 'Uniqueness',
  phone_shared: 'Uniqueness',
  email_shared: 'Uniqueness',
  city_pin_consistency: 'Consistency',
  clustering_freshness: 'Freshness',
  sql_run_freshness: 'Freshness',
  row_count_change: 'Volume',
};

/** Rule names as the worker labels them (SPECS), for the thresholds table. */
export const RULE_NAMES: Record<string, string> = {
  completeness_required: 'Required field filled in',
  completeness_optional: 'Optional field filled in',
  validity: 'Values in the expected format',
  customer_id_unique: 'Every customer id present and unique',
  phone_shared: 'Customers sharing a phone number',
  email_shared: 'Customers sharing an email address',
  city_pin_consistency: "City matches the PIN code's region",
  clustering_freshness: 'Hours since clusters were built',
  sql_run_freshness: 'Hours since the SQL was last run',
  row_count_change: 'Row count change since the last check',
};

export function ruleKind(rule: string): RuleKind {
  return KIND_OF_RULE[rule] ?? 'Validity';
}

/** Results grouped by kind, in the order of RULE_KINDS; empty kinds are left out. */
export function groupByKind(
  results: QualityResult[],
): { kind: RuleKind; results: QualityResult[] }[] {
  return RULE_KINDS.map((kind) => ({
    kind,
    results: results.filter((result) => ruleKind(result.rule) === kind),
  })).filter((group) => group.results.length > 0);
}

export function unitOfRule(rule: string): 'percent' | 'hours' {
  return rule.endsWith('_freshness') ? 'hours' : 'percent';
}

export function formatMetric(value: number, unit: 'percent' | 'hours'): string {
  const text = value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return unit === 'percent' ? `${text}%` : `${text} h`;
}

/** "Warn below 99%, fail below 95%" (or "above" for rules that should stay low). */
export function thresholdText(
  threshold: QualityThreshold,
  direction: 'min' | 'max',
  unit: 'percent' | 'hours',
): string {
  const side = direction === 'min' ? 'below' : 'above';
  const warn = `Warn ${side} ${formatMetric(threshold.warn, unit)}`;
  const fail =
    threshold.fail === null ? 'never fails' : `fail ${side} ${formatMetric(threshold.fail, unit)}`;
  return `${warn}, ${fail}`;
}

export function formatDuration(startedAt: string, finishedAt: string): string {
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}
