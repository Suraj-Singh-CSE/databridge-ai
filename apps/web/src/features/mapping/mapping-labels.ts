import type { StatusTone } from '@/components/StatusPill';
import type {
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
  return source.status === 'profiled' || source.status === 'ready';
}
