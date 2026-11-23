import type { StatusTone } from '@/components/StatusPill';
import { ApiError } from '@/lib/api';
import type { DataScope, SqlCheck, SqlMethod, SqlStatus, SqlVersionSummary } from '@/lib/api-types';

export const SQL_STATUS: Record<SqlStatus, { label: string; tone: StatusTone }> = {
  draft: { label: 'Draft', tone: 'review' },
  approved: { label: 'Approved', tone: 'high' },
  rejected: { label: 'Rejected', tone: 'low' },
  superseded: { label: 'Superseded', tone: 'neutral' },
};

export const CHECK_STATUS: Record<SqlCheck['status'], { label: string; tone: StatusTone }> = {
  passed: { label: 'Passed', tone: 'high' },
  failed: { label: 'Failed', tone: 'low' },
  skipped: { label: 'Skipped', tone: 'neutral' },
};

export const SCOPE_LABELS: Record<DataScope, string> = {
  approved: 'Approved only',
  all: 'All customers',
};

export function methodLabel(method: SqlMethod): string {
  return method === 'llm' ? 'AI' : 'Reference query';
}

const CHECK_NAMES: Record<string, string> = {
  columns: 'Columns in schema order',
  row_count: 'Row count',
  customer_id_unique: 'Customer ID unique',
  customer_id_known: 'Customer IDs known',
  golden_equality: 'Matches golden records',
  runtime: 'Run time',
};

/** The lowest `equalPercent` of the golden-records check, when it reported one. */
function lowestEqualPercent(check: SqlCheck): number | null {
  const fields = check.details.fields;
  if (!Array.isArray(fields)) return null;
  const percents = fields
    .map((f: unknown) =>
      typeof f === 'object' && f !== null && 'equalPercent' in f ? f.equalPercent : null,
    )
    .filter((p): p is number => typeof p === 'number');
  return percents.length ? Math.min(...percents) : null;
}

/** A check's name in plain words, e.g. "Matches golden records 100%". */
export function checkLabel(check: SqlCheck): string {
  const name = CHECK_NAMES[check.name] ?? check.name.replaceAll('_', ' ');
  if (check.name !== 'golden_equality') return name;
  const percent = lowestEqualPercent(check);
  return percent === null ? name : `${name} ${percent.toLocaleString('en-US')}%`;
}

/** "5/6 tests passed", or why there are no test results. */
export function testsText(version: SqlVersionSummary): string {
  if (!version.tests) return version.error ? 'Not tested (failed)' : 'Not tested';
  const { passedCount, checkCount } = version.tests.summary;
  return `${passedCount}/${checkCount} passed`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Plain-language text for a failed download. */
export function downloadErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'The download failed. Please try again.';
  if (error.status === 0)
    return 'We could not reach the server. Check your connection and try again.';
  if (error.status === 403)
    return 'You do not have permission to download exports in this project.';
  if (error.status === 404) return 'This export file is no longer available. Refresh the list.';
  return error.message;
}
