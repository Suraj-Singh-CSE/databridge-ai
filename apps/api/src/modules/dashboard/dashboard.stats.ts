/**
 * Nearest-rank percentile of an ascending list (p in (0, 1]); null for an empty list. The median
 * is the lower middle value for an even count, so every result is a value that was measured.
 */
export function percentile(sortedAscending: readonly number[], p: number): number | null {
  if (sortedAscending.length === 0) return null;
  const rank = Math.max(1, Math.ceil(p * sortedAscending.length));
  return sortedAscending[Math.min(rank, sortedAscending.length) - 1] ?? null;
}

/** Rounded to 2 decimals (costs in INR, milliseconds). */
export const round2 = (value: number): number => Math.round(value * 100) / 100;

/** UTC days from `since` to `until` inclusive, as YYYY-MM-DD. */
export function daysBetween(since: Date, until: Date): string[] {
  const days: string[] = [];
  const day = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate()));
  while (day.getTime() <= until.getTime()) {
    days.push(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return days;
}
