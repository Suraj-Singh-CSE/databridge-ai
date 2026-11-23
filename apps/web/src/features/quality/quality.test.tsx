import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http } from 'msw';
import { describe, expect, it } from 'vitest';

import type {
  ProjectRole,
  QualityResult,
  QualityRulesView,
  QualityRun,
  QualityRunSummary,
} from '@/lib/api-types';
import { API, fail, makeProject, makeSession, ok, signedInHandlers } from '@/test/fixtures';
import { renderApp } from '@/test/render-app';
import { server } from '@/test/server';

import { groupByKind, thresholdText } from './quality-labels';

/** The value, or a thrown error when a test's element or fixture is missing. */
function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing');
  return value;
}

const PROJECT_ID = '64b0000000000000000000a1';
const PATH = `/projects/${PROJECT_ID}/quality`;
const USER_ID = '64b000000000000000000001';

function result(overrides: Partial<QualityResult>): QualityResult {
  return {
    rule: 'validity',
    label: 'Values in the expected format',
    field: null,
    status: 'pass',
    metric: 100,
    unit: 'percent',
    direction: 'min',
    threshold: { warn: 99, fail: 95 },
    message: '',
    counts: {},
    exampleIds: [],
    ...overrides,
  };
}

const RESULTS: QualityResult[] = [
  result({
    rule: 'completeness_required',
    label: 'Required field filled in',
    field: 'phone',
    metric: 99.4,
    status: 'warn',
    threshold: { warn: 100, fail: 99 },
    exampleIds: ['C000000000001', 'C000000000002'],
  }),
  result({ rule: 'validity', field: 'email', status: 'fail', metric: 91.25 }),
  result({
    rule: 'phone_shared',
    label: 'Customers sharing a phone number',
    metric: 1.5,
    direction: 'max',
    threshold: { warn: 2, fail: null },
  }),
  result({
    rule: 'city_pin_consistency',
    label: "City matches the PIN code's region",
    status: 'skipped',
    metric: null,
    message: 'No values to compare.',
  }),
  result({
    rule: 'sql_run_freshness',
    label: 'Hours since the SQL was last run',
    metric: 3,
    unit: 'hours',
    direction: 'max',
    threshold: { warn: 24, fail: 168 },
  }),
];

const RUN: QualityRun = {
  id: '64b0000000000000000000d3',
  projectId: PROJECT_ID,
  jobId: '64b0000000000000000000d3',
  startedAt: '2026-11-22T10:00:00.000Z',
  finishedAt: '2026-11-22T10:00:02.500Z',
  source: {
    kind: 'sql_version',
    label: 'Final SQL v3',
    versionId: '64b0000000000000000000e3',
    version: 3,
    scope: 'approved',
    sqlTestsPassed: true,
    failedChecks: [],
  },
  clusteringRunId: 'k1',
  schemaVersion: 1,
  rowCount: 4987,
  status: 'fail',
  statusCounts: { pass: 2, warn: 1, fail: 1, skipped: 1 },
  ruleCount: 5,
  results: RESULTS,
  config: {
    rules: {
      validity: { enabled: true, warn: 99, fail: 95 },
      phone_shared: { enabled: true, warn: 2, fail: null },
      email_shared: { enabled: false, warn: 2, fail: null },
    },
    fields: {},
  },
  createdBy: USER_ID,
};

function summaryOf(run: QualityRun, overrides: Partial<QualityRunSummary> = {}): QualityRunSummary {
  const { results: _results, config: _config, ...rest } = run;
  return { ...rest, ...overrides };
}

const HISTORY: QualityRunSummary[] = [
  summaryOf(RUN),
  summaryOf(RUN, {
    id: '64b0000000000000000000d2',
    status: 'pass',
    statusCounts: { pass: 5, warn: 0, fail: 0, skipped: 0 },
  }),
];

const RULES: QualityRulesView = {
  rules: { validity: { warn: 99, fail: 95 }, email_shared: { enabled: false } },
  fields: { phone: { warn: 90, fail: null } },
  updatedBy: USER_ID,
  updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
  catalogue: [
    { rule: 'validity', direction: 'min', max: 100 },
    { rule: 'phone_shared', direction: 'max', max: 100 },
    { rule: 'email_shared', direction: 'max', max: 100 },
    { rule: 'clustering_freshness', direction: 'max', max: 8760 },
  ],
};

interface Setup {
  latest?: QualityRun | null;
  history?: QualityRunSummary[];
  member?: ProjectRole;
}

function setup({ latest = RUN, history = HISTORY, member }: Setup = {}) {
  const project = makeProject({
    currentStep: 'quality',
    ownerId: member ? '64b000000000000000000009' : USER_ID,
    members: member ? [{ userId: USER_ID, role: member }] : [],
  });
  server.use(
    ...signedInHandlers(makeSession(member ?? 'data_engineer')),
    http.get(`${API}/projects/:id`, () => ok({ project })),
    http.get(`${API}/projects/:id/quality/latest`, () => ok({ run: latest })),
    http.get(`${API}/projects/:id/quality/runs`, () =>
      ok({ items: history, page: 1, limit: 20, total: history.length }),
    ),
    http.get(`${API}/projects/:id/quality/rules`, () => ok({ rules: RULES })),
  );
  return renderApp(PATH);
}

describe('quality: latest report', () => {
  it('shows the overall status, source, rows, run time and counts', async () => {
    setup();
    const report = present(
      (await screen.findByRole('heading', { name: 'Latest report' })).closest('section'),
    );
    expect(within(report).getByText('Overall: Fail')).toBeInTheDocument();
    expect(within(report).getByText('Final SQL v3')).toBeInTheDocument();
    expect(within(report).getByText('4,987')).toBeInTheDocument();
    expect(within(report).getByText('2.5 s')).toBeInTheDocument();
    const counts = within(report).getByRole('list', { name: 'Rules by status' });
    expect(
      within(counts)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Passed2', 'Warnings1', 'Failed1', 'Skipped1']);
  });

  it('groups the rules by kind with metric, threshold, status text and skipped reason', async () => {
    setup();
    await screen.findByRole('heading', { name: 'Latest report' });
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(
      expect.arrayContaining([
        'Completeness',
        'Validity',
        'Uniqueness',
        'Consistency',
        'Freshness',
      ]),
    );
    expect(screen.queryByRole('table', { name: 'Volume rules' })).not.toBeInTheDocument();

    const completeness = screen.getByRole('table', { name: 'Completeness rules' });
    const row = present(within(completeness).getAllByRole('row')[1]);
    expect(row).toHaveTextContent('Required field filled in');
    expect(row).toHaveTextContent('phone');
    expect(row).toHaveTextContent('99.4%');
    expect(row).toHaveTextContent('Warn below 100%, fail below 99%');
    expect(within(row).getByText('Warning')).toBeInTheDocument();

    const validity = screen.getByRole('table', { name: 'Validity rules' });
    expect(within(validity).getByText('Fail')).toBeInTheDocument();
    expect(within(validity).getByText('91.25%')).toBeInTheDocument();

    const uniqueness = screen.getByRole('table', { name: 'Uniqueness rules' });
    expect(within(uniqueness).getByText('Warn above 2%, never fails')).toBeInTheDocument();

    const consistency = screen.getByRole('table', { name: 'Consistency rules' });
    expect(within(consistency).getByText('Skipped: No values to compare.')).toBeInTheDocument();
    expect(within(consistency).getByText('Skipped')).toBeInTheDocument();

    const freshness = screen.getByRole('table', { name: 'Freshness rules' });
    expect(within(freshness).getByText('3 h')).toBeInTheDocument();
  });

  it('opens and closes the example customer ids with the keyboard', async () => {
    setup();
    await screen.findByRole('heading', { name: 'Latest report' });
    const toggle = screen.getByRole('button', {
      name: 'Show example customer ids for Required field filled in (phone)',
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('C000000000001')).not.toBeInTheDocument();

    const user = userEvent.setup();
    toggle.focus();
    await user.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const ids = screen.getByRole('list', { name: 'Example customer ids' });
    expect(
      within(ids)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['C000000000001', 'C000000000002']);
    await user.keyboard(' ');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('C000000000001')).not.toBeInTheDocument();
  });

  it('notes when the SQL used failed some of its tests', async () => {
    setup({
      latest: {
        ...RUN,
        source: { ...RUN.source, sqlTestsPassed: false, failedChecks: ['row_count'] },
      },
    });
    expect(
      await screen.findByText('The SQL used did not pass all its tests (row_count).'),
    ).toBeInTheDocument();
  });

  it('explains when there is no report yet', async () => {
    setup({ latest: null, history: [] });
    expect(
      await screen.findByRole('heading', { name: 'No quality report yet' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'History' })).not.toBeInTheDocument();
    expect(
      await screen.findByText(/Exact values show here after the first report/),
    ).toBeInTheDocument();
  });

  it('shows a loading state, then an error with a retry', async () => {
    let attempts = 0;
    setup();
    server.use(
      http.get(`${API}/projects/:id/quality/latest`, async () => {
        attempts += 1;
        await delay(20);
        return attempts === 1
          ? fail(500, 'INTERNAL_ERROR', 'Reports are unavailable.')
          : ok({ run: RUN });
      }),
    );
    expect(await screen.findByLabelText('Loading the latest report')).toBeInTheDocument();
    expect(await screen.findByText('Reports are unavailable.')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Latest report' })).toBeInTheDocument();
  });

  it('shows a read-only note to members who cannot run the checks', async () => {
    setup({ member: 'data_steward' });
    expect(await screen.findByText(/You can view the quality reports/)).toBeInTheDocument();
  });
});

describe('quality: history and thresholds', () => {
  it('lists past runs with their status and counts', async () => {
    setup();
    const table = await screen.findByRole('table', { name: 'Past quality reports' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(present(rows[0])).getByText('Fail')).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent(/Fail2111$/);
    expect(rows[1]).toHaveTextContent(/Pass5000$/);
  });

  it('says when there are no past runs', async () => {
    setup({ history: [] });
    expect(await screen.findByText('No past reports yet.')).toBeInTheDocument();
  });

  it('shows a history error with a retry', async () => {
    setup();
    server.use(
      http.get(`${API}/projects/:id/quality/runs`, () =>
        fail(500, 'INTERNAL_ERROR', 'History is unavailable.'),
      ),
    );
    expect(await screen.findByText('We could not load past reports')).toBeInTheDocument();
    expect(screen.getByText('History is unavailable.')).toBeInTheDocument();
  });

  it('shows the thresholds the latest report used and what the project changed', async () => {
    setup();
    const table = await screen.findByRole('table', { name: 'Thresholds in use' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      'Values in the expected formatHigher99%95%Changed for this project',
      'Customers sharing a phone numberLower2%Never failsDefault',
      'Customers sharing an email addressLower2%Never failsTurned off',
      'Hours since clusters were builtLowerDefaultDefaultDefault',
    ]);
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === 'P' &&
          element.textContent.startsWith('Last changed 1 hour ago by you.'),
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/warn below 90%, fail never/)).toBeInTheDocument();
  });

  it('shows a thresholds error', async () => {
    setup();
    server.use(
      http.get(`${API}/projects/:id/quality/rules`, () =>
        fail(403, 'FORBIDDEN', 'You are not a member of this project.'),
      ),
    );
    expect(await screen.findByText('We could not load the thresholds')).toBeInTheDocument();
  });

  it('formats thresholds and groups in kind order', () => {
    expect(thresholdText({ warn: 24, fail: 168 }, 'max', 'hours')).toBe(
      'Warn above 24 h, fail above 168 h',
    );
    expect(groupByKind(RESULTS).map((g) => g.kind)).toEqual([
      'Completeness',
      'Validity',
      'Uniqueness',
      'Consistency',
      'Freshness',
    ]);
  });
});
