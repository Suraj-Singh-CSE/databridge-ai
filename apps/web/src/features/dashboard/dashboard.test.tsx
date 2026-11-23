import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http } from 'msw';
import { describe, expect, it } from 'vitest';

import type { Dashboard, ProjectRole } from '@/lib/api-types';
import { API, fail, makeProject, makeSession, ok, signedInHandlers } from '@/test/fixtures';
import { renderApp } from '@/test/render-app';
import { server } from '@/test/server';

import { adrLabel, errorCodeText, formatCost, formatDuration } from './dashboard-labels';

const PROJECT_ID = '64b0000000000000000000a1';
const PATH = `/projects/${PROJECT_ID}/dashboard`;
const USER_ID = '64b000000000000000000001';

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing');
  return value;
}

const AI_TOTALS = {
  calls: 42,
  ok: 40,
  failed: 2,
  failedBy: [{ status: 'RESOURCE_EXHAUSTED', httpCode: 429, errorType: 'rate_limit', count: 2 }],
  cacheHits: 5,
  schemaFallbacks: 1,
  inputTokens: 12000,
  outputTokens: 3400,
  costInr: 0,
  costLabel: 'free tier' as const,
  latencyMs: { p50: 820, p95: 2400, samples: 35 },
  models: ['gemini-3.5-flash-lite'],
};

/** Shape copied from apps/api dashboard.service.ts `Dashboard` (dates as JSON strings). */
function makeDashboard(overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    range: {
      key: '30d',
      days: 30,
      since: '2026-10-24T00:00:00.000Z',
      until: '2026-11-23T00:00:00.000Z',
    },
    pipeline: {
      sources: {
        count: 3,
        byStatus: {
          uploaded: 0,
          profiling: 0,
          profiled: 0,
          standardised: 0,
          ready: 3,
          failed: 0,
        },
        rowsUploaded: 6095,
      },
      mapping: {
        sourcesMapped: 3,
        columns: 24,
        decided: 20,
        pending: 4,
        sourcesOnRules: 1,
        outdated: true,
      },
      standardise: { sources: 3, rows: 6095, rowsWithIssues: 31, outdated: false },
      candidates: { ran: true, pairs: 1322, outdated: false },
      scores: {
        ran: true,
        pairs: 1322,
        byBand: { match: 1200, maybe: 80, non_match: 42 },
        outdated: false,
      },
      aiReview: { ran: true, pairs: 80, reviewed: 78, unavailable: 2 },
      clusters: {
        ran: true,
        customers: 4987,
        multiRecord: 900,
        recordsMerged: 1108,
        needsReview: 27,
        approved: 412,
        proposed: 4548,
        outdated: false,
      },
      sql: {
        latest: { version: 3, status: 'approved', testsPassed: true, method: 'llm' },
        approvedVersion: 3,
        outdated: false,
      },
      exports: { count: 2, outdated: true },
      quality: { latest: { status: 'warn', at: '2026-11-22T10:00:00.000Z' }, outdated: false },
      nextStep: { text: 'Review 27 customers that need a decision', step: 'matching' },
    },
    quality: {
      runs: [
        { at: '2026-11-20T10:00:00.000Z', status: 'fail', pass: 6, warn: 2, fail: 2 },
        { at: '2026-11-22T10:00:00.000Z', status: 'warn', pass: 8, warn: 1, fail: 0 },
      ],
      latestRules: [
        {
          rule: 'validity',
          field: 'email',
          label: 'Values in the expected format',
          status: 'pass',
          metric: 99.8,
          unit: 'percent',
        },
        {
          rule: 'completeness_required',
          field: 'phone',
          label: 'Required field filled in',
          status: 'warn',
          metric: 99.4,
          unit: 'percent',
        },
        {
          rule: 'city_pin_consistency',
          field: null,
          label: "City matches the PIN code's region",
          status: 'skipped',
          metric: null,
          unit: 'percent',
        },
      ],
    },
    ai: {
      tasks: [{ task: 'mapping', ...AI_TOTALS }],
      total: AI_TOTALS,
      fallbacks: { mappingSourcesOnRules: 1, sqlReferenceVersions: 0, pairReviewUnavailable: 2 },
      daily: [
        { date: '2026-11-21', calls: 10, tokens: 4000, costInr: 0 },
        { date: '2026-11-22', calls: 32, tokens: 11400, costInr: 0 },
      ],
    },
    review: {
      total: 33,
      byType: {
        mapping_accept: 18,
        mapping_reject: 1,
        mapping_override: 1,
        mapping_accept_high: 0,
        match_approve: 12,
        match_approve_high: 0,
        match_split: 0,
        match_merge: 0,
        match_undo: 0,
        sql_approve: 1,
        sql_reject: 0,
        quality_rules_change: 0,
      },
      byRole: { owner: 20, data_steward: 13 },
      medianTimeToDecisionMs: { mapping: { medianMs: 180_000, samples: 20 } },
    },
    jobs: {
      byType: [
        {
          type: 'profile',
          total: 3,
          succeeded: 3,
          failed: 0,
          failedBy: [],
          cancelled: 0,
          active: 0,
          durationMs: { median: 1500, p95: 2500 },
        },
        {
          type: 'clustering',
          total: 2,
          succeeded: 1,
          failed: 1,
          failedBy: [{ code: 'SCORES_OUTDATED', count: 1 }],
          cancelled: 0,
          active: 0,
          durationMs: { median: 4200, p95: 4200 },
        },
        {
          type: 'export',
          total: 0,
          succeeded: 0,
          failed: 0,
          failedBy: [],
          cancelled: 0,
          active: 0,
          durationMs: { median: null, p95: null },
        },
      ],
      recentFailures: [
        { type: 'clustering', code: 'SCORES_OUTDATED', at: '2026-11-21T09:00:00.000Z' },
      ],
    },
    benchmarks: {
      version: 1,
      items: [
        {
          id: 'pair_scoring',
          title: 'Pair scoring (match band) on the untouched holdout',
          dataset: 'synthetic',
          set: 'seed 2028, untouched holdout',
          source: 'docs/adr/0016-pair-scoring.md',
          measuredOn: '2026-11-22',
          metrics: [
            { name: 'precision', value: 100, unit: 'percent', display: '100.00%' },
            { name: 'recall', value: 99.18, unit: 'percent', display: '99.18%' },
          ],
          evidence: ['| seed 2028 |'],
        },
      ],
    },
    ...overrides,
  };
}

const EMPTY_PIPELINE: Dashboard['pipeline'] = {
  ...makeDashboard().pipeline,
  sources: {
    count: 0,
    byStatus: { uploaded: 0, profiling: 0, profiled: 0, standardised: 0, ready: 0, failed: 0 },
    rowsUploaded: 0,
  },
  nextStep: { text: 'Upload a file from each system', step: 'sources' },
};

interface Setup {
  dashboard?: Dashboard;
  member?: ProjectRole;
  respond?: Parameters<typeof http.get>[1];
}

function setup({ dashboard = makeDashboard(), member, respond }: Setup = {}) {
  const project = makeProject({
    id: PROJECT_ID,
    ownerId: member ? '64b000000000000000000009' : USER_ID,
    members: member ? [{ userId: USER_ID, role: member }] : [],
  });
  const ranges: (string | null)[] = [];
  server.use(
    ...signedInHandlers(makeSession(member ?? 'data_engineer')),
    http.get(`${API}/projects/:id`, () => ok({ project })),
    http.get(
      `${API}/projects/:id/dashboard`,
      respond ??
        (({ request }) => {
          ranges.push(new URL(request.url).searchParams.get('range'));
          return ok(dashboard);
        }),
    ),
  );
  renderApp(PATH);
  return { ranges };
}

const section = async (name: string) =>
  present((await screen.findByRole('heading', { name, level: 2 })).closest('section'));

describe('dashboard', () => {
  it('renders every section from the API response, viewers included', async () => {
    const { ranges } = setup({ member: 'viewer' });
    for (const name of [
      'Next step',
      'Pipeline',
      'Data quality',
      'AI usage',
      'Human review',
      'Job health',
      'Benchmark results — measured on synthetic test data',
    ]) {
      expect(await screen.findByRole('heading', { name, level: 2 })).toBeInTheDocument();
    }
    expect(ranges).toEqual(['30d']);
    expect(screen.getByRole('radio', { name: 'Last 30 days' })).toBeChecked();
  });

  it('links the next step to its page', async () => {
    setup();
    const next = await section('Next step');
    expect(within(next).getByText('Review 27 customers that need a decision')).toBeInTheDocument();
    expect(within(next).getByRole('link', { name: 'Go to Matching' })).toHaveAttribute(
      'href',
      `/projects/${PROJECT_ID}/matching`,
    );
  });

  it('shows pipeline counts with "Out of date" pills where outdated', async () => {
    setup();
    const pipeline = await section('Pipeline');
    expect(within(pipeline).getByText('4,987')).toBeInTheDocument();
    expect(within(pipeline).getByText('1,108')).toBeInTheDocument();
    expect(within(pipeline).getByText('20 decided')).toBeInTheDocument();
    expect(within(pipeline).getByText('4 waiting for a decision')).toBeInTheDocument();
    expect(within(pipeline).getByText('v3 · Approved')).toBeInTheDocument();
    expect(within(pipeline).getByText('Warning')).toBeInTheDocument();
    expect(within(pipeline).getAllByText('Out of date')).toHaveLength(2);
    const mapping = present(within(pipeline).getByText('Columns mapped').closest('div'));
    expect(within(mapping).getByText('Out of date')).toBeInTheDocument();
  });

  it('refetches with the chosen range (keyboard)', async () => {
    const user = userEvent.setup();
    const { ranges } = setup();
    await section('Pipeline');
    await user.click(screen.getByRole('radio', { name: 'Last 30 days' }));
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Last 90 days' })).toBeChecked();
    await waitFor(() => {
      expect(ranges).toEqual(['30d', '90d']);
    });
    await user.click(screen.getByRole('radio', { name: 'Last 7 days' }));
    await waitFor(() => {
      expect(ranges).toEqual(['30d', '90d', '7d']);
    });
  });

  it('labels a zero cost as free tier and gives text alternatives for the bars', async () => {
    setup();
    const ai = await section('AI usage');
    expect(within(ai).getAllByText('₹0 (free tier)').length).toBeGreaterThan(0);
    expect(within(ai).getByText('820 ms / 2.4 s')).toBeInTheDocument();
    expect(within(ai).getByText('3')).toBeInTheDocument(); // fallbacks to rules: 1 + 0 + 2
    expect(within(ai).getByRole('table', { name: 'AI usage by task' })).toHaveTextContent(
      'Column mapping',
    );
    expect(
      within(ai).getByRole('img', {
        name: '42 AI calls over 2 days; the busiest day was 2026-11-22 with 32 calls.',
      }),
    ).toBeInTheDocument();
    expect(
      within(ai).getByRole('table', { name: 'AI calls, tokens and cost per day' }),
    ).toBeInTheDocument();

    const quality = await section('Data quality');
    expect(
      within(quality).getByRole('img', { name: /2 quality checks in this period/ }),
    ).toHaveAccessibleName(
      '2 quality checks in this period. First: 6 passed, 2 warnings, 2 failed. Latest: 8 passed, 1 warnings, 0 failed.',
    );
    expect(
      within(quality).getByRole('table', { name: 'Quality checks in this period' }),
    ).toBeInTheDocument();
    const counts = within(quality).getByRole('list', { name: 'Latest rules by status' });
    expect(
      within(counts)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Pass: 1', 'Warning: 1', 'Fail: 0', 'Skipped: 1']);
  });

  it('shows review counts by type and role, and job health with failures in plain words', async () => {
    setup();
    const review = await section('Human review');
    expect(within(review).getByRole('table', { name: 'Decisions by type' })).toHaveTextContent(
      'Mapping accepted18',
    );
    expect(within(review).getByRole('table', { name: 'Decisions by role' })).toHaveTextContent(
      'Data steward13',
    );
    expect(
      within(review).getByRole('table', { name: 'Median time from suggestion to decision' }),
    ).toHaveTextContent('Column mapping3.0 min20');

    const jobs = await section('Job health');
    const table = within(jobs).getByRole('table', { name: 'Jobs by type' });
    expect(within(table).getAllByRole('row')).toHaveLength(3); // header + 2 used types
    expect(table).toHaveTextContent('Group into customers');
    expect(within(jobs).getByText('Pair scores were out of date')).toBeInTheDocument();
  });

  it('labels benchmarks as synthetic with their ADR and date', async () => {
    setup();
    const benchmarks = await section('Benchmark results — measured on synthetic test data');
    expect(within(benchmarks).getByText('100.00%')).toBeInTheDocument();
    expect(within(benchmarks).getByText('Precision')).toBeInTheDocument();
    expect(
      within(benchmarks).getByText(/ADR 0016 · measured 2026-11-22 · seed 2028/),
    ).toBeInTheDocument();
  });

  it('shows zeros and an upload link for an empty project', async () => {
    setup({ dashboard: makeDashboard({ pipeline: EMPTY_PIPELINE }) });
    expect(await screen.findByRole('link', { name: 'Upload your first file' })).toHaveAttribute(
      'href',
      `/projects/${PROJECT_ID}/sources`,
    );
    expect(screen.queryByRole('heading', { name: 'Next step' })).not.toBeInTheDocument();
    const pipeline = await section('Pipeline');
    expect(within(pipeline).getAllByText('0').length).toBeGreaterThan(0);
  });

  it('shows a loading state, then an error with a retry that works', async () => {
    const user = userEvent.setup();
    let calls = 0;
    setup({
      respond: async () => {
        calls += 1;
        await delay(20);
        return calls === 1
          ? fail(500, 'INTERNAL_ERROR', 'The server had a problem.')
          : ok(makeDashboard());
      },
    });
    expect(
      await screen.findByRole('status', { name: 'Loading the dashboard' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('We could not load the dashboard')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Pipeline' })).toBeInTheDocument();
  });
});

describe('dashboard labels', () => {
  it('formats durations, cost, ADR references and error codes in plain words', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(412)).toBe('412 ms');
    expect(formatDuration(2500)).toBe('2.5 s');
    expect(formatDuration(7_200_000)).toBe('2.0 h');
    expect(formatCost(0)).toBe('₹0 (free tier)');
    expect(formatCost(12.5)).toBe('₹12.5');
    expect(adrLabel('docs/adr/0021-sql-agent.md')).toBe('ADR 0021');
    expect(errorCodeText('SOMETHING_ODD')).toBe('Something odd');
    expect(errorCodeText(null)).toBe('No reason recorded');
  });
});
