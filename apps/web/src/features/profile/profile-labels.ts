import type { StatusTone } from '@/components/StatusPill';
import type { ColumnProfile, InferredType } from '@/lib/api-types';

export const TYPE_LABELS: Record<InferredType, string> = {
  string: 'Text',
  integer: 'Whole number',
  decimal: 'Decimal number',
  boolean: 'Yes / no',
  date: 'Date',
  datetime: 'Date and time',
  email: 'Email',
  phone: 'Phone',
  empty: 'Empty',
};

/** "Personal data" describes the column rather than a problem with it. */
const INFORMATIONAL_FLAGS = new Set(['PERSONAL_DATA', 'POSSIBLE_ID']);
const SERIOUS_FLAGS = new Set(['EMPTY_COLUMN', 'HIGH_EMPTY_RATE', 'TYPE_MISMATCH']);

export function flagTone(code: string): StatusTone {
  if (INFORMATIONAL_FLAGS.has(code)) return 'neutral';
  return SERIOUS_FLAGS.has(code) ? 'low' : 'review';
}

/** A column needs a look when it has a flag other than the informational ones. */
export function hasIssues(column: ColumnProfile): boolean {
  return column.flags.some((flag) => !INFORMATIONAL_FLAGS.has(flag.code));
}
