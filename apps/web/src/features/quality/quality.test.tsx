import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http } from 'msw';
import { describe, expect, it } from 'vitest';

import type {
  Job,
  ProjectRole,
  QualityResult,
  QualityRulesView,
  QualityRun,
  QualityRunSummary,
} from '@/lib/api-types';
import {
  API,
  fail,
  jobFrame,
  makeJob,
  makeProject,
  makeSession,
  ok,
  signedInHandlers,
  sseChannel,
} from '@/test/fixtures';
import { renderApp } from '@/test/render-app';
import { server } from '@/test/server';

import { groupByKind, thresholdText } from './quality-labels';
import { DEFAULT_ROW, overridesOf, validateRow } from './threshold-form';

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
  jobs?: Job[];
}

function setup({ latest = RUN, history = HISTORY, member, jobs = [] }: Setup = {}) {
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
    http.get(`${API}/projects/:id/jobs`, () => ok({ items: jobs })),
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

  it('shows a note to data stewards, who run checks but cannot change thresholds', async () => {
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

describe('quality: actions', () => {
  it('runs the quality checks with live progress and refreshes the report and history', async () => {
    const events = sseChannel();
    let body: unknown = null;
    let reads = { latest: 0, runs: 0 };
    setup({ member: 'data_steward' });
    server.use(
      http.post(`${API}/projects/:id/jobs`, async ({ request }) => {
        body = await request.json();
        return ok(
          { job: makeJob({ type: 'quality', status: 'queued', progress: 0, payload: {} }) },
          202,
        );
      }),
      http.get(`${API}/jobs/:id/events`, () => events.response()),
      http.get(`${API}/projects/:id/quality/latest`, () => {
        reads = { ...reads, latest: reads.latest + 1 };
        return ok({ run: RUN });
      }),
      http.get(`${API}/projects/:id/quality/runs`, () => {
        reads = { ...reads, runs: reads.runs + 1 };
        return ok({ items: HISTORY, page: 1, limit: 20, total: HISTORY.length });
      }),
    );
    const user = userEvent.setup();
    const button = await screen.findByRole('button', { name: 'Run quality checks' });
    await screen.findByRole('table', { name: 'Past quality reports' });
    const before = { ...reads };
    await user.click(button);
    await waitFor(() => {
      expect(body).toEqual({ type: 'quality', payload: {} });
    });
    events.send(jobFrame({ status: 'running', progress: 60, message: 'Checking validity' }));
    expect(await screen.findByText('60% done')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Run quality checks' })).toBeInTheDocument();
    // Stewards cannot cancel jobs (the api allows data engineers and up).
    expect(screen.queryByRole('button', { name: /^Cancel/ })).not.toBeInTheDocument();
    expect(button).toHaveAttribute('aria-disabled', 'true');

    events.send(
      jobFrame({
        status: 'succeeded',
        progress: 100,
        result: { statusCounts: { pass: 6, warn: 2, fail: 1, skipped: 0 } },
      }),
    );
    events.close();
    expect(
      await screen.findByText(
        'The quality check finished: 6 passed, 2 warnings, 1 failed. The report below is up to date.',
      ),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(reads.latest).toBeGreaterThan(before.latest);
      expect(reads.runs).toBeGreaterThan(before.runs);
    });
  });

  it('explains a check the api refuses', async () => {
    setup();
    server.use(
      http.post(`${API}/projects/:id/jobs`, () =>
        fail(409, 'CONFLICT', 'A quality check is already running. Wait for that job to finish.', {
          reason: 'QUALITY_RUNNING',
        }),
      ),
    );
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Run quality checks' }));
    expect(await screen.findByText(/A quality check is already running/)).toBeInTheDocument();
  });

  it('shows the actions each role may use', async () => {
    setup({ member: 'viewer' });
    expect(
      await screen.findByText(
        /Only the project owner, an admin, a data engineer or a data steward can run the checks/,
      ),
    ).toBeInTheDocument();
    await screen.findByRole('table', { name: 'Thresholds in use' });
    expect(screen.queryByRole('button', { name: 'Run quality checks' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit thresholds' })).not.toBeInTheDocument();
  });

  it('lets a data steward run the checks but not edit thresholds', async () => {
    setup({ member: 'data_steward' });
    expect(await screen.findByRole('button', { name: 'Run quality checks' })).toBeInTheDocument();
    await screen.findByRole('table', { name: 'Thresholds in use' });
    expect(screen.queryByRole('button', { name: 'Edit thresholds' })).not.toBeInTheDocument();
  });

  it('edits thresholds with validation, reset to default and a PUT of the overrides', async () => {
    let body: unknown = null;
    setup();
    server.use(
      http.put(`${API}/projects/:id/quality/rules`, async ({ request }) => {
        body = await request.json();
        return ok({ rules: { ...RULES, rules: { validity: { warn: 98, fail: 90 } } } });
      }),
    );
    const user = userEvent.setup();
    const trigger = await screen.findByRole('button', { name: 'Edit thresholds' });
    expect(screen.queryByText(/You can view the quality reports/)).not.toBeInTheDocument();
    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Edit thresholds' });
    const validity = within(dialog).getByRole('group', { name: 'Values in the expected format' });
    const warn = within(validity).getByRole('spinbutton', { name: 'Warn below (%)' });
    const fail = within(validity).getByRole('spinbutton', { name: 'Fail below (%)' });
    expect(warn).toHaveValue(99);
    expect(fail).toHaveValue(95);
    const email = within(dialog).getByRole('group', { name: 'Customers sharing an email address' });
    expect(within(email).getByRole('checkbox', { name: 'Check this rule' })).not.toBeChecked();
    const freshness = within(dialog).getByRole('group', {
      name: 'Hours since clusters were built',
    });
    expect(within(freshness).getByRole('spinbutton', { name: 'Warn above (hours)' })).toHaveValue(
      null,
    );

    // Fail above warn on a rule that should stay high, and a value out of range.
    await user.clear(fail);
    await user.type(fail, '100');
    const phone = within(dialog).getByRole('group', { name: 'Customers sharing a phone number' });
    await user.type(within(phone).getByRole('spinbutton', { name: 'Warn above (%)' }), '120');
    await user.click(within(dialog).getByRole('button', { name: 'Save thresholds' }));
    expect(
      within(dialog).getByText('Fail must be at or below warn: this value should stay high.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('Enter a number from 0 to 100.')).toBeInTheDocument();
    expect(fail).toHaveAttribute('aria-invalid', 'true');
    expect(body).toBeNull();

    await user.clear(warn);
    await user.type(warn, '98');
    await user.clear(fail);
    await user.type(fail, '90');
    await user.click(within(phone).getByRole('button', { name: /Reset .* to default/ }));
    await user.click(
      within(email).getByRole('button', {
        name: 'Reset Customers sharing an email address to default',
      }),
    );
    await user.click(within(freshness).getByRole('checkbox', { name: 'Only warn, never fail' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save thresholds' }));

    await waitFor(() => {
      expect(body).toEqual({
        rules: { validity: { warn: 98, fail: 90 }, clustering_freshness: { fail: null } },
        fields: { phone: { warn: 90, fail: null } },
      });
    });
    expect(
      await screen.findByText('Thresholds saved. They apply from the next quality check.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('shows the api refusal of thresholds in the dialog', async () => {
    setup();
    server.use(
      http.put(`${API}/projects/:id/quality/rules`, () =>
        fail(403, 'FORBIDDEN', 'You do not have access to this project.'),
      ),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit thresholds' }));
    await user.click(screen.getByRole('button', { name: 'Save thresholds' }));
    expect(
      await within(screen.getByRole('dialog')).findByText(
        'You do not have permission to do this in this project.',
      ),
    ).toBeInTheDocument();
  });

  it('validates threshold rows like the api', () => {
    const min = { rule: 'validity', direction: 'min' as const, max: 100 };
    const max = { rule: 'clustering_freshness', direction: 'max' as const, max: 8760 };
    expect(validateRow({ ...DEFAULT_ROW, warn: '99', fail: '95' }, min)).toEqual({});
    expect(validateRow({ ...DEFAULT_ROW, warn: '24', fail: '12' }, max)).toEqual({
      fail: 'Fail must be at or above warn: this value should stay low.',
    });
    expect(validateRow({ ...DEFAULT_ROW, warn: '9000' }, max)).toEqual({
      warn: 'Enter a number from 0 to 8760.',
    });
    expect(validateRow({ ...DEFAULT_ROW, warn: '-1' }, min).warn).toBe(
      'Enter a number from 0 to 100.',
    );
    // "Never fail" ignores the typed fail value.
    expect(validateRow({ ...DEFAULT_ROW, warn: '10', fail: '50', neverFails: true }, min)).toEqual(
      {},
    );
    expect(
      overridesOf({
        validity: DEFAULT_ROW,
        phone_shared: { enabled: false, warn: '', fail: '', neverFails: false },
        email_shared: { enabled: true, warn: '2.5', fail: '', neverFails: true },
      }),
    ).toEqual({ phone_shared: { enabled: false }, email_shared: { warn: 2.5, fail: null } });
  });
});
