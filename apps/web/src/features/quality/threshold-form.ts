import type { QualityRuleOverride } from '@/lib/api-types';

import { RULE_NAMES, unitOfRule } from './quality-labels';

/** One rule's inputs as typed; an empty number means "use the default". */
export interface RuleRow {
  enabled: boolean;
  warn: string;
  fail: string;
  neverFails: boolean;
}

export interface RuleSpec {
  rule: string;
  direction: 'min' | 'max';
  max: number;
  defaults: { warn: number; fail: number | null };
}

export type RowErrors = Partial<Record<'warn' | 'fail', string>>;

export const DEFAULT_ROW: RuleRow = { enabled: true, warn: '', fail: '', neverFails: false };

export function rowFromOverride(override: QualityRuleOverride | undefined): RuleRow {
  if (!override) return DEFAULT_ROW;
  return {
    enabled: override.enabled !== false,
    warn: override.warn === undefined ? '' : String(override.warn),
    fail: typeof override.fail === 'number' ? String(override.fail) : '',
    neverFails: override.fail === null,
  };
}

/** "Warn below (%)", "Fail above (hours)": what the number means for this rule. */
export function inputLabel(kind: 'warn' | 'fail', spec: RuleSpec): string {
  const verb = kind === 'warn' ? 'Warn' : 'Fail';
  const side = spec.direction === 'min' ? 'below' : 'above';
  const unit = unitOfRule(spec.rule) === 'hours' ? 'hours' : '%';
  return `${verb} ${side} (${unit})`;
}

function amount(value: number, spec: RuleSpec): string {
  const text = value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return unitOfRule(spec.rule) === 'hours' ? `${text} hours` : `${text}%`;
}

/** "Default: warn below 99%, fail below 95%." or "…; it never fails." in plain words. */
export function defaultsText(spec: RuleSpec): string {
  const side = spec.direction === 'min' ? 'below' : 'above';
  const { warn, fail } = spec.defaults;
  const failText = fail === null ? 'never fail' : `fail ${side} ${amount(fail, spec)}`;
  return `Default: warn ${side} ${amount(warn, spec)}, ${failText}.`;
}

export function ruleName(rule: string): string {
  return RULE_NAMES[rule] ?? rule.replaceAll('_', ' ');
}

function parse(text: string, max: number): { value: number | null; error?: string } {
  const trimmed = text.trim();
  if (trimmed === '') return { value: null };
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return { value: null, error: 'Enter a number.' };
  if (value < 0 || value > max) return { value: null, error: `Enter a number from 0 to ${max}.` };
  return { value };
}

/** The same checks as the api: 0 to the rule's maximum, and fail on the worse side of warn. */
export function validateRow(row: RuleRow, spec: RuleSpec): RowErrors {
  const errors: RowErrors = {};
  const warn = parse(row.warn, spec.max);
  const fail = row.neverFails ? { value: null } : parse(row.fail, spec.max);
  if (warn.error) errors.warn = warn.error;
  if (fail.error) errors.fail = fail.error;
  if (warn.value !== null && fail.value !== null) {
    if (spec.direction === 'min' && fail.value > warn.value) {
      errors.fail = 'Fail must be at or below warn: this value should stay high.';
    }
    if (spec.direction === 'max' && fail.value < warn.value) {
      errors.fail = 'Fail must be at or above warn: this value should stay low.';
    }
  }
  return errors;
}

/** The override to store for a row, or null when the row is all defaults. */
export function overrideFromRow(row: RuleRow): QualityRuleOverride | null {
  const override: QualityRuleOverride = {};
  if (!row.enabled) override.enabled = false;
  if (row.warn.trim() !== '') override.warn = Number(row.warn);
  if (row.neverFails) override.fail = null;
  else if (row.fail.trim() !== '') override.fail = Number(row.fail);
  return Object.keys(override).length > 0 ? override : null;
}

/** Every changed rule's override, keyed by rule id. */
export function overridesOf(rows: Record<string, RuleRow>): Record<string, QualityRuleOverride> {
  const result: Record<string, QualityRuleOverride> = {};
  for (const [rule, row] of Object.entries(rows)) {
    const override = overrideFromRow(row);
    if (override) result[rule] = override;
  }
  return result;
}
