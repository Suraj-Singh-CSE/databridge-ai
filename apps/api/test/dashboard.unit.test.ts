import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { BENCHMARKS } from '../src/modules/dashboard/benchmarks.js';
import { daysBetween, percentile, round2 } from '../src/modules/dashboard/dashboard.stats.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
/** Markdown tables are padded for alignment: compare with runs of whitespace collapsed. */
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

describe('dashboard benchmarks match the ADRs they quote', () => {
  it.each(BENCHMARKS.items.map((b) => [b.id, b] as const))('%s', (_id, benchmark) => {
    expect(benchmark.dataset).toBe('synthetic');
    expect(benchmark.source).toMatch(/^docs\/adr\/\d{4}-[a-z0-9-]+\.md$/);
    const adr = readFileSync(path.join(REPO_ROOT, benchmark.source), 'utf8');
    const text = squash(adr);

    expect(adr).toContain(benchmark.measuredOn);
    for (const line of benchmark.evidence) expect(text).toContain(squash(line));
    for (const metric of benchmark.metrics) {
      expect(
        benchmark.evidence.some((line) => line.includes(metric.display)),
        `${metric.name} "${metric.display}" is not in the quoted evidence`,
      ).toBe(true);
      const shown = Number.parseFloat(metric.display.replaceAll(',', ''));
      expect(metric.value).toBe(shown);
    }
  });

  it('has unique ids and a version', () => {
    const ids = BENCHMARKS.items.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(BENCHMARKS.version).toBeGreaterThanOrEqual(1);
  });
});

describe('dashboard stats helpers', () => {
  it('takes nearest-rank percentiles of an ascending list', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3], 0.5)).toBe(2);
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.95)).toBe(100);
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.9)).toBe(90);
  });

  it('lists every UTC day of a range, both ends included', () => {
    const until = new Date('2026-11-23T05:00:00Z');
    const since = new Date(until.getTime() - 7 * 86_400_000);
    const days = daysBetween(since, until);
    expect(days).toHaveLength(8);
    expect(days[0]).toBe('2026-11-16');
    expect(days.at(-1)).toBe('2026-11-23');
  });

  it('rounds to two decimals', () => {
    expect(round2(0.123456)).toBe(0.12);
    expect(round2(1.005 * 1000)).toBe(1005);
  });
});
