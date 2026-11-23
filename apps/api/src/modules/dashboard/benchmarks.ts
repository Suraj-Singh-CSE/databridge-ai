/**
 * Offline evaluation results shown on the dashboard, copied from the ADRs that record them.
 * Every number was measured on synthetic data (eval/, ADR 0008), never on a customer's data.
 *
 * Kept honest by test/dashboard.unit.test.ts: each `evidence` line must appear in the ADR named
 * by `source` (whitespace ignored), each metric's `display` must appear in that evidence, its
 * `value` must be the number in `display`, and `measuredOn` must appear in the ADR. Change an
 * ADR's numbers and the test fails until this file is updated (bump `version` when you do).
 */
export interface BenchmarkMetric {
  name: string;
  value: number;
  unit: 'percent' | 'count';
  /** The figure exactly as the ADR prints it. */
  display: string;
}

export interface Benchmark {
  id: string;
  title: string;
  dataset: 'synthetic';
  /** Which synthetic set (e.g. the untouched holdout). */
  set: string;
  /** ADR path from the repository root. */
  source: string;
  /** YYYY-MM-DD: the ADR's date, or the date of the run it reports. */
  measuredOn: string;
  metrics: BenchmarkMetric[];
  /** Lines quoted from the ADR that hold the metrics. */
  evidence: string[];
}

export interface Benchmarks {
  version: number;
  items: Benchmark[];
}

const pct = (name: string, display: string): BenchmarkMetric => ({
  name,
  value: Number.parseFloat(display),
  unit: 'percent',
  display,
});
const count = (name: string, display: string): BenchmarkMetric => ({
  name,
  value: Number.parseInt(display.replaceAll(',', ''), 10),
  unit: 'count',
  display,
});

export const BENCHMARKS: Benchmarks = {
  version: 1,
  items: [
    {
      id: 'mapping_unseen_headers',
      title: 'Column mapping on unseen headers: rules only vs hybrid (rules + LLM)',
      dataset: 'synthetic',
      set: 'unseen-header holdout (5 systems, 44 columns), gemini-3.5-flash-lite',
      source: 'docs/adr/0013-mapping-evaluation-and-holdout.md',
      measuredOn: '2026-11-22',
      metrics: [
        pct('rules_accuracy', '72.7% (32/44)'),
        pct('hybrid_accuracy', '81.8% (36/44)'),
        pct('rules_accuracy_at_high', '81.0% (17/21)'),
        pct('hybrid_accuracy_at_high', '90.5% (19/21)'),
      ],
      evidence: [
        '| unseen | rules | 44 | 72.7% (32/44) | 81.0% (17/21) | 4 | 60.0% | 100% |',
        '| unseen | hybrid | 44 | 81.8% (36/44) | 90.5% (19/21) | 2 | 65.2% | 100% |',
        '### Run 3: `gemini-3.5-flash-lite` (2026-11-22)',
      ],
    },
    {
      id: 'blocking',
      title: 'Blocking: true pairs kept and comparisons avoided',
      dataset: 'synthetic',
      set: 'full set, seed 42 (6,095 records)',
      source: 'docs/adr/0015-blocking.md',
      measuredOn: '2026-11-22',
      metrics: [
        pct('pair_completeness', '99.54% (1288/1294)'),
        pct('reduction_ratio', '99.9929%'),
        pct('pairs_quality', '97.4%'),
      ],
      evidence: [
        '| full (seed 42) | 6,095 | 1,294 | 1,322 | 99.54% (1288/1294) | 99.9929% | 97.4% |',
      ],
    },
    {
      id: 'pair_scoring',
      title: 'Pair scoring (match band) on the untouched holdout',
      dataset: 'synthetic',
      set: 'seed 2028, untouched holdout',
      source: 'docs/adr/0016-pair-scoring.md',
      measuredOn: '2026-11-22',
      metrics: [
        pct('precision', '100.00%'),
        pct('recall', '99.18%'),
        pct('f1', '99.59%'),
        count('false_matches', '0'),
      ],
      evidence: [
        '| seed 2028 (holdout, untouched) | em | 1,380 | 1336 / 10 / 34 | 100.00% | 99.18% | 99.59% | 0 | 0.74% (10) | 99.11% (1336/1348) |',
      ],
    },
    {
      id: 'golden_records',
      title: 'Clusters and golden records: people rebuilt exactly',
      dataset: 'synthetic',
      set: 'seed 2029, untouched holdout (run once)',
      source: 'docs/adr/0018-clusters-and-golden-records.md',
      measuredOn: '2026-11-22',
      metrics: [
        pct('people_exactly_rebuilt', '99.96% (4998)'),
        pct('pairwise_precision', '100%'),
        count('over_merged_clusters', '0'),
      ],
      evidence: [
        '| seed 2029 (untouched, run once) | 6,125 | 5002 (4071) | 100% / 99.85% / 99.92% | 100% / 99.97% / 99.98% | 99.96% (4998) | 0 | 2 | 0 |',
      ],
    },
    {
      id: 'quality_fault_injection',
      title: 'Data quality rules: injected faults detected',
      dataset: 'synthetic',
      set: 'seed 42 samples with 5 kinds of injected faults',
      source: 'docs/adr/0022-data-quality.md',
      measuredOn: '2026-11-23',
      metrics: [pct('detection_precision', '100%'), pct('detection_recall', '100%')],
      evidence: ['precision and recall are 100% for all five, and CI fails otherwise.'],
    },
    {
      id: 'sql_validator',
      title: 'SQL validator: malicious queries refused',
      dataset: 'synthetic',
      set: 'security set of malicious queries',
      source: 'docs/adr/0021-sql-agent.md',
      measuredOn: '2026-11-23',
      metrics: [count('malicious_queries_refused', '26')],
      evidence: ['security set of 26 malicious queries, all refused by the validator.'],
    },
  ],
};
