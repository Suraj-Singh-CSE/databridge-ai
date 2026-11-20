import { describe, expect, it } from 'vitest';

import { formatRelativeTime } from '@/lib/relative-time';

const now = new Date('2026-11-21T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

describe('formatRelativeTime', () => {
  it.each([
    [10_000, 'just now'],
    [2 * 60_000, '2 min ago'],
    [60 * 60_000, '1 hour ago'],
    [5 * 60 * 60_000, '5 hours ago'],
    [26 * 60 * 60_000, 'yesterday'],
    [3 * 24 * 60 * 60_000, '3 days ago'],
  ])('%i ms ago reads "%s"', (ms, expected) => {
    expect(formatRelativeTime(ago(ms), now)).toBe(expected);
  });

  it('falls back to a date after a month', () => {
    expect(formatRelativeTime('2026-03-01T10:00:00Z', now)).toBe('on 1 Mar 2026');
  });
});
