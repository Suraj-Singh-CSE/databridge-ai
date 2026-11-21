import type { StatusTone } from '@/components/StatusPill';
import { ApiError } from '@/lib/api';
import type {
  AcceptHighResult,
  ConfidenceLabel,
  MappingMethod,
  MappingRole,
  MappingStatus,
  Source,
} from '@/lib/api-types';

export const CONFIDENCE_TONES: Record<ConfidenceLabel, StatusTone> = {
  High: 'high',
  Medium: 'review',
  Low: 'low',
};

/** "High · 97%": confidence is always shown with words, never colour alone. */
export function confidenceText(label: ConfidenceLabel, confidence: number): string {
  return `${label} · ${formatConfidence(confidence)}`;
}

export function formatConfidence(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

export const STATUS_LABELS: Record<MappingStatus, string> = {
  pending: 'Pending',
  accepted: 'Accepted',
  rejected: 'Rejected',
  overridden: 'Changed',
};

export const STATUS_TONES: Record<MappingStatus, StatusTone> = {
  pending: 'neutral',
  accepted: 'high',
  rejected: 'low',
  overridden: 'review',
};

export const METHOD_LABELS: Record<MappingMethod, string> = {
  hybrid: 'AI + rules',
  rules: 'Rules only',
};

/** What a suggestion points at, in words, when there is no target field. */
export function targetLabel(target: string | null, role: MappingRole): string {
  if (role === 'source_record_id') return 'Record ID';
  return target ?? 'Not mapped';
}

const TRANSFORMS: Record<string, string> = {
  lowercase: 'Make lowercase',
  uppercase: 'Make uppercase',
  to_e164_in: 'Format as +91 phone',
  digits_only: 'Keep digits only',
  concat: 'Join with the other name parts',
  split_name: 'Split the full name',
  title_case: 'Capitalise each word',
  trim: 'Trim extra spaces',
};

/** Cleaning hints from apps/ai-service/app/mapping/rules.py, in plain words. */
export function transformLabel(transform: string | null): string {
  if (transform === null) return 'None';
  if (transform.startsWith('parse_date:')) {
    return `Read dates as ${transform.slice('parse_date:'.length)}`;
  }
  return TRANSFORMS[transform] ?? transform;
}

/** Only profiled files have the column profile the mapping engine works from. */
export function isMappable(source: Source): boolean {
  return source.status === 'profiled';
}

const DATE_FORMATS = ['DD/MM/YYYY', 'DD-MM-YYYY', 'YYYY-MM-DD', 'YYYY/MM/DD', 'DD-Mon-YYYY'];

/** Cleaning steps a reviewer may pick (the api accepts exactly these codes). */
export const TRANSFORM_CODES: readonly string[] = [
  'trim',
  'lowercase',
  'uppercase',
  'title_case',
  'digits_only',
  'to_e164_in',
  'split_name',
  'concat',
  ...DATE_FORMATS.map((format) => `parse_date:${format}`),
];

function conflictDetails(details: unknown): { column: string; target: string } | null {
  if (typeof details !== 'object' || details === null) return null;
  const { column, target } = details as Record<string, unknown>;
  return typeof column === 'string' && typeof target === 'string' ? { column, target } : null;
}

/** Plain-language reason a decision, bulk accept or mapping run failed. */
export function mappingErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Please try again.';
  if (error.status === 403) return 'You do not have permission to do this in this project.';
  if (error.code === 'CONFLICT') {
    const held = conflictDetails(error.details);
    if (held)
      return `‘${held.target}’ is already used by column ‘${held.column}’. Change that one first.`;
    return error.message || 'This clashes with another decision. Change that one first.';
  }
  if (error.code === 'VALIDATION_ERROR')
    return 'That choice is not allowed. Pick a field from the list.';
  return error.message;
}

/** "Accepted 3 columns. 1 was already decided. 1 could not be accepted: its field is taken." */
export function acceptHighSummary({ accepted, alreadyDecided, conflicts }: AcceptHighResult) {
  const parts = [`Accepted ${accepted} ${accepted === 1 ? 'column' : 'columns'}.`];
  if (alreadyDecided > 0) {
    parts.push(`${alreadyDecided} ${alreadyDecided === 1 ? 'was' : 'were'} already decided.`);
  }
  if (conflicts > 0) {
    parts.push(
      `${conflicts} could not be accepted because the field is already used or no longer exists.`,
    );
  }
  return parts.join(' ');
}
