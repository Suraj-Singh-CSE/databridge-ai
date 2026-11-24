import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ExportView,
  Job,
  ProjectRole,
  SqlCheck,
  SqlVersion,
  SqlVersionSummary,
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

import { checkLabel } from './pipeline-labels';

/** The value, or a thrown error when a test's element or fixture is missing. */
function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing');
  return value;
}

const PROJECT_ID = '64b0000000000000000000a1';
const PATH = `/projects/${PROJECT_ID}/pipeline`;
const USER_ID = '64b000000000000000000001';
const ENGINEER_ID = '64b000000000000000000002';

const PASSED_CHECKS: SqlCheck[] = [
  { name: 'columns', status: 'passed', message: 'All 9 columns, in schema order.', details: {} },
  { name: 'row_count', status: 'passed', message: '4,987 rows.', details: {} },
  {
    name: 'customer_id_unique',
    status: 'passed',
    message: 'customer_id is unique and never empty.',
    details: {},
  },
  {
    name: 'golden_equality',
    status: 'passed',
    message: 'Every field equals the golden records.',
    details: { fields: [{ field: 'phone', equalCount: 4987, equalPercent: 100, mismatchIds: [] }] },
  },
];

function makeVersion(overrides: Partial<SqlVersion> = {}): SqlVersion {
  return {
    id: '64b0000000000000000000e3',
    projectId: PROJECT_ID,
    jobId: '64b0000000000000000000e3',
    version: 3,
    sql: "-- golden records\nSELECT g.customer_id, g.full_name\nFROM golden_records AS g\nWHERE g.status = 'approved'",
    explanation: 'Takes one row per approved customer from the golden records.',
    assumptions: ['Phone numbers are already in E.164 form.'],
    method: 'llm',
    model: 'mock-model',
    promptVersion: 'v1',
    fallbackReason: null,
    scope: 'approved',
    instructions: null,
    validation: { ok: true, code: null, message: null },
    error: null,
    tests: {
      passed: true,
      checks: PASSED_CHECKS,
      summary: {
        passedCount: 4,
        checkCount: 4,
        rowCount: 4987,
        expectedRowCount: 4987,
        durationMs: 120,
      },
    },
    testsPassed: true,
    attempts: [],
    usage: null,
    status: 'approved',
    createdBy: ENGINEER_ID,
    createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    clusteringRunId: 'k1',
    schemaVersion: 1,
    lastRun: {
      runId: 'r1',
      passed: true,
      rowCount: 4987,
      finishedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    },
    approvedBy: USER_ID,
    approvedAt: new Date(Date.now() - 2.5 * 3_600_000).toISOString(),
    rejectedBy: null,
    rejectedAt: null,
    rejectReason: null,
    supersededAt: null,
    ...overrides,
  };
}

const APPROVED = makeVersion();
const FAILED_DRAFT = makeVersion({
  id: '64b0000000000000000000e4',
  version: 4,
  status: 'draft',
  method: 'reference',
  model: null,
  sql: 'SELECT 1',
  testsPassed: false,
  lastRun: null,
  approvedBy: null,
  approvedAt: null,
  tests: {
    passed: false,
    checks: [
      present(PASSED_CHECKS[0]),
      {
        name: 'customer_id_unique',
        status: 'failed',
        message: '12 customer ids appear more than once.',
        details: {},
      },
    ],
    summary: {
      passedCount: 1,
      checkCount: 2,
      rowCount: 4999,
      expectedRowCount: 4987,
      durationMs: 90,
    },
  },
});
const OLD = makeVersion({
  id: '64b0000000000000000000e2',
  version: 2,
  status: 'superseded',
  supersededAt: new Date().toISOString(),
});

function summary(version: SqlVersion): SqlVersionSummary {
  const { sql: _sql, attempts: _attempts, ...rest } = version;
  return rest;
}

const CSV_EXPORT: ExportView = {
  id: '64b0000000000000000000f1',
  projectId: PROJECT_ID,
  jobId: '64b0000000000000000000f1',
  format: 'csv',
  scope: 'approved',
  includeSources: false,
  rowCount: 4987,
  bytes: 524_288,
  sha256: 'a'.repeat(64),
  clusteringRunId: 'k1',
  schemaVersion: 1,
  status: 'ready',
  createdBy: ENGINEER_ID,
  createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
  filename: 'customer-360-demo-2026-11-22.csv',
};

interface Setup {
  versions?: SqlVersion[];
  exports?: ExportView[];
  member?: ProjectRole;
  jobs?: Job[];
}

function setup({
  versions = [FAILED_DRAFT, APPROVED, OLD],
  exports = [CSV_EXPORT],
  member,
  jobs = [],
}: Setup = {}) {
  const project = makeProject({
    currentStep: 'pipeline',
    ownerId: member ? '64b000000000000000000009' : USER_ID,
    members: [
      { userId: ENGINEER_ID, role: 'data_engineer' },
      ...(member ? [{ userId: USER_ID, role: member }] : []),
    ],
  });
  server.use(
    ...signedInHandlers(makeSession(member ?? 'data_engineer')),
    http.get(`${API}/projects/:id`, () => ok({ project })),
    http.get(`${API}/projects/:id/sql/versions`, () => ok({ items: versions.map(summary) })),
    http.get(`${API}/projects/:id/sql/versions/:versionId`, ({ params }) => {
      const found = versions.find((v) => v.id === params.versionId);
      return found ? ok({ version: found }) : fail(404, 'NOT_FOUND', 'SQL version not found.');
    }),
    http.get(`${API}/projects/:id/exports`, () => ok({ items: exports })),
    http.get(`${API}/projects/:id/jobs`, () => ok({ items: jobs })),
  );
  return renderApp(PATH);
}

function section(name: string): HTMLElement {
  const heading = screen.getByRole('heading', { name, level: 2 });
  const element = heading.closest('section');
  if (!element) throw new Error(`no section ${name}`);
  return element;
}

describe('pipeline: current SQL and versions', () => {
  it('shows the approved version with its explanation, SQL and passing tests', async () => {
    setup();
    const heading = await screen.findByRole('heading', { name: 'Current SQL · version 3' });
    const current = present(heading.closest('section'));
    expect(await within(current).findByText(APPROVED.explanation)).toBeInTheDocument();
    expect(
      within(current).getByText('Phone numbers are already in E.164 form.'),
    ).toBeInTheDocument();
    expect(within(current).getByText('AI (mock-model)')).toBeInTheDocument();
    expect(within(current).getByText('Approved only')).toBeInTheDocument();
    expect(within(current).getByText(/by you/)).toBeInTheDocument();
    expect(within(current).getByText(/by a data engineer/)).toBeInTheDocument();
    const code = within(current).getByLabelText('SQL of version 3');
    expect(code).toHaveTextContent("WHERE g.status = 'approved'");
    expect(code).toHaveAttribute('tabindex', '0');
    expect(
      within(current).getByText('4 of 4 tests passed · 4,987 rows (expected 4,987)'),
    ).toBeInTheDocument();
    expect(within(current).getByText('Matches golden records 100%')).toBeInTheDocument();
    expect(within(current).getByText('Customer ID unique')).toBeInTheDocument();
    expect(within(current).getAllByText('Passed')).toHaveLength(4);
    expect(within(current).getByText(/4,987 rows · passed/)).toBeInTheDocument();
  });

  it('lists every version with its status and tests, and opens one with its failing checks', async () => {
    setup();
    const versions = await screen.findByRole('table', { name: 'SQL versions' });
    const rows = within(versions).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/^v4Draft1\/2 passed/),
      expect.stringMatching(/^v3Approved4\/4 passed/),
      expect.stringMatching(/^v2Superseded4\/4 passed/),
    ]);

    const user = userEvent.setup();
    const view = screen.getByRole('button', { name: 'View version 4' });
    await user.click(view);
    expect(view).toHaveAttribute('aria-expanded', 'true');
    const details = await screen.findByRole('region', { name: 'Version 4 details' });
    expect(
      await within(details).findByText('12 customer ids appear more than once.'),
    ).toBeInTheDocument();
    expect(within(details).getByText('Failed')).toBeInTheDocument();
    expect(within(details).getByText('Reference query')).toBeInTheDocument();
    expect(within(details).getByText('Not run yet')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Hide version 4' }));
    expect(screen.queryByRole('region', { name: 'Version 4 details' })).not.toBeInTheDocument();
  });

  it('explains when there is no SQL version yet', async () => {
    setup({ versions: [] });
    expect(await screen.findByRole('heading', { name: 'No SQL version yet' })).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'SQL versions' })).not.toBeInTheDocument();
  });

  it('says when no version is approved yet but still lists the drafts', async () => {
    setup({ versions: [FAILED_DRAFT] });
    expect(await screen.findByRole('heading', { name: 'No approved SQL yet' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'SQL versions' })).toBeInTheDocument();
  });

  it('shows a loading state, then an error with a retry', async () => {
    let attempts = 0;
    setup();
    server.use(
      http.get(`${API}/projects/:id/sql/versions`, async () => {
        attempts += 1;
        await delay(20);
        return attempts === 1
          ? fail(500, 'INTERNAL_ERROR', 'The SQL versions could not be read.')
          : ok({ items: [summary(APPROVED)] });
      }),
    );
    expect(await screen.findByLabelText('Loading SQL versions')).toBeInTheDocument();
    expect(await screen.findByText('The SQL versions could not be read.')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('heading', { name: 'Current SQL · version 3' }),
    ).toBeInTheDocument();
  });

  it('shows a read-only note to members who cannot manage the pipeline', async () => {
    setup({ member: 'viewer' });
    expect(
      await screen.findByText(/You can view the SQL and download exports/),
    ).toBeInTheDocument();
  });

  it('labels the golden-records check with its lowest match percentage', () => {
    expect(
      checkLabel({
        name: 'golden_equality',
        status: 'failed',
        message: '',
        details: {
          fields: [
            { field: 'phone', equalPercent: 99.5 },
            { field: 'email', equalPercent: 97.25 },
          ],
        },
      }),
    ).toBe('Matches golden records 97.25%');
    expect(checkLabel({ name: 'new_check', status: 'passed', message: '', details: {} })).toBe(
      'new check',
    );
  });
});

describe('pipeline: exports', () => {
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:export-1');
  const revokeObjectURL = vi.fn();
  const clicked: { href: string; download: string }[] = [];

  beforeEach(() => {
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    clicked.length = 0;
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ href: this.href, download: this.download });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('lists the exports with the CSV note', async () => {
    setup();
    const table = await screen.findByRole('table', { name: 'Exports' });
    const row = present(within(table).getAllByRole('row')[1]);
    expect(row).toHaveTextContent('csv');
    expect(row).toHaveTextContent('Approved only');
    expect(row).toHaveTextContent('4,987');
    expect(row).toHaveTextContent('512.0 KB');
    expect(row).toHaveTextContent('by a data engineer');
    expect(
      screen.getByText("Phone numbers start with ' in CSV to stop spreadsheet formulas."),
    ).toBeInTheDocument();
  });

  it('downloads with the bearer token and saves under the name from Content-Disposition', async () => {
    let auth: string | null = null;
    let release: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => {
      release = resolve;
    });
    setup();
    server.use(
      http.get(`${API}/projects/:id/exports/:exportId/download`, async ({ request }) => {
        auth = request.headers.get('Authorization');
        // Answers only once the test has seen the pending state.
        await answered;
        return new HttpResponse("customer_id,phone\nC1,'+91\n", {
          headers: {
            'Content-Type': 'text/csv',
            'Content-Disposition': 'attachment; filename="from-header.csv"',
          },
        });
      }),
    );
    const user = userEvent.setup();
    const button = await screen.findByRole('button', {
      name: `Download ${CSV_EXPORT.filename}`,
    });
    await user.click(button);
    expect(await screen.findByText('Downloading…')).toBeInTheDocument();
    expect(button).toBeDisabled();
    release();
    expect(await screen.findByText('Downloaded from-header.csv.')).toBeInTheDocument();
    expect(auth).toBe('Bearer access-1');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]?.[0];
    expect(await blob?.text()).toContain('customer_id,phone');
    expect(clicked).toEqual([{ href: 'blob:export-1', download: 'from-header.csv' }]);
    expect(button).toBeEnabled();
    await waitFor(() => {
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:export-1');
    });
  });

  it('falls back to the listed filename when the header has none', async () => {
    setup();
    server.use(
      http.get(
        `${API}/projects/:id/exports/:exportId/download`,
        () => new HttpResponse('x', { headers: { 'Content-Type': 'text/csv' } }),
      ),
    );
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: `Download ${CSV_EXPORT.filename}` }));
    expect(await screen.findByText(`Downloaded ${CSV_EXPORT.filename}.`)).toBeInTheDocument();
    expect(clicked[0]?.download).toBe(CSV_EXPORT.filename);
  });

  it('explains a failed download in plain words', async () => {
    setup();
    server.use(
      http.get(`${API}/projects/:id/exports/:exportId/download`, () =>
        fail(404, 'NOT_FOUND', 'Export not found.'),
      ),
    );
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: `Download ${CSV_EXPORT.filename}` }));
    expect(
      await screen.findByText('This export file is no longer available. Refresh the list.'),
    ).toBeInTheDocument();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('explains when there are no exports', async () => {
    setup({ exports: [] });
    expect(await screen.findByRole('heading', { name: 'No exports yet' })).toBeInTheDocument();
  });

  it('shows an error when the exports cannot be loaded', async () => {
    setup();
    server.use(
      http.get(`${API}/projects/:id/exports`, () =>
        fail(500, 'INTERNAL_ERROR', 'Exports are unavailable.'),
      ),
    );
    expect(await screen.findByText('We could not load the exports')).toBeInTheDocument();
    expect(within(section('Exports')).getByText('Exports are unavailable.')).toBeInTheDocument();
  });
});

const PASSING_DRAFT = makeVersion({
  id: '64b0000000000000000000e5',
  version: 5,
  status: 'draft',
  lastRun: null,
  approvedBy: null,
  approvedAt: null,
});

function queuedJob(type: Job['type'], payload: Record<string, unknown>): Job {
  return makeJob({
    type,
    status: 'queued',
    progress: 0,
    message: '',
    payload,
    projectId: PROJECT_ID,
  });
}

/** POST .../jobs answering `job`; the request bodies are collected in `bodies`. */
function acceptJobs(job: Job, bodies: unknown[]) {
  return http.post(`${API}/projects/:id/jobs`, async ({ request }) => {
    bodies.push(await request.json());
    return ok({ job }, 202);
  });
}

describe('pipeline: SQL actions', () => {
  it('drafts SQL with scope and instructions, follows the job and opens the new version', async () => {
    const events = sseChannel();
    const bodies: unknown[] = [];
    let versions = [APPROVED];
    setup({ versions });
    server.use(
      acceptJobs(queuedJob('sql_draft', { scope: 'all' }), bodies),
      http.get(`${API}/jobs/:id/events`, () => events.response()),
      http.get(`${API}/projects/:id/sql/versions`, () => ok({ items: versions.map(summary) })),
      http.get(`${API}/projects/:id/sql/versions/:versionId`, ({ params }) => {
        const found = versions.find((v) => v.id === params.versionId);
        return found ? ok({ version: found }) : fail(404, 'NOT_FOUND', 'SQL version not found.');
      }),
    );
    const user = userEvent.setup();
    const trigger = await screen.findByRole('button', { name: 'Draft SQL' });
    await user.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: 'Draft SQL' });
    expect(
      within(dialog).getByText(
        "Don't include customer details — describe the rule, e.g. 'prefer CRM for phone'.",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('0/500 characters')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('radio', { name: /All customers/ }));
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Instructions (optional)' }),
      'prefer CRM for phone',
    );
    expect(within(dialog).getByText('20/500 characters')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Start draft' }));

    await waitFor(() => {
      expect(bodies).toEqual([
        { type: 'sql_draft', payload: { scope: 'all', instructions: 'prefer CRM for phone' } },
      ]);
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const draft = section('Draft SQL');
    expect(await within(draft).findByText('Waiting to start')).toBeInTheDocument();
    events.send(jobFrame({ status: 'running', progress: 50, message: 'Testing on the sample' }));
    expect(await within(draft).findByText('50% done')).toBeInTheDocument();
    expect(within(draft).getByRole('button', { name: 'Cancel: Draft SQL' })).toBeEnabled();

    versions = [PASSING_DRAFT, APPROVED];
    events.send(
      jobFrame({
        status: 'succeeded',
        progress: 100,
        result: { versionId: PASSING_DRAFT.id, version: 5 },
      }),
    );
    events.close();
    expect(
      await within(draft).findByText('Version 5 is drafted. Its details and tests are open below.'),
    ).toBeInTheDocument();
    const details = await screen.findByRole('region', { name: 'Version 5 details' });
    expect(within(details).getByRole('button', { name: 'Approve version 5' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Hide version 5' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('explains instructions refused because they look like personal data', async () => {
    const events = sseChannel();
    setup();
    server.use(
      acceptJobs(queuedJob('sql_draft', { scope: 'approved' }), []),
      http.get(`${API}/jobs/:id/events`, () => events.response()),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Draft SQL' }));
    await user.click(screen.getByRole('button', { name: 'Start draft' }));
    const draft = section('Draft SQL');
    expect(await within(draft).findByText('Waiting to start')).toBeInTheDocument();
    events.send(
      jobFrame({
        status: 'failed',
        progress: 10,
        error: { code: 'INSTRUCTIONS_CONTAIN_PII', message: 'The instructions contain PII.' },
      }),
    );
    events.close();
    expect(
      await within(draft).findByText(/look like they contain customer details/),
    ).toBeInTheDocument();
  });

  it('keeps the draft dialog open with a plain message when the api refuses the start', async () => {
    setup();
    server.use(
      http.post(`${API}/projects/:id/jobs`, () =>
        fail(
          409,
          'CONFLICT',
          'No customer is approved yet. Approve customers in Match Review, or draft the SQL for all customers.',
          { reason: 'NOTHING_APPROVED' },
        ),
      ),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Draft SQL' }));
    await user.click(screen.getByRole('button', { name: 'Start draft' }));
    const dialog = screen.getByRole('dialog', { name: 'Draft SQL' });
    expect(await within(dialog).findByText(/No customer is approved yet/)).toBeInTheDocument();
  });

  it('disables Approve with the reason while a draft has failing tests', async () => {
    setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'View version 4' }));
    const details = await screen.findByRole('region', { name: 'Version 4 details' });
    const approve = await within(details).findByRole('button', { name: 'Approve version 4' });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAccessibleDescription('All tests must pass before approval.');
    expect(within(details).getByRole('button', { name: 'Reject version 4' })).toBeEnabled();
  });

  it('approves a passing draft after a confirm that explains the superseded version', async () => {
    let approved = '';
    let body: unknown = null;
    setup({ versions: [PASSING_DRAFT, APPROVED] });
    server.use(
      http.post(
        `${API}/projects/:id/sql/versions/:versionId/approve`,
        async ({ params, request }) => {
          approved = String(params.versionId);
          body = await request.json();
          return ok({ version: { ...PASSING_DRAFT, status: 'approved' } });
        },
      ),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'View version 5' }));
    const trigger = await screen.findByRole('button', { name: 'Approve version 5' });
    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Approve version 5?' });
    expect(dialog).toHaveTextContent(
      'Version 3 is the current SQL. It becomes Superseded and version 5 becomes the current SQL.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(approved).toBe(PASSING_DRAFT.id);
    });
    expect(body).toEqual({});
    expect(
      await screen.findByText('Version 5 approved. It is now the current SQL.'),
    ).toBeInTheDocument();
  });

  it('keeps the approval message when the decision buttons unmount before the refetch ends', async () => {
    // Like the real api: once approved, the version reads back as approved (so the decision
    // buttons go away) while the slower version list is still being re-read.
    let decided = false;
    const nowApproved = { ...PASSING_DRAFT, status: 'approved' as const };
    setup({ versions: [PASSING_DRAFT, APPROVED] });
    server.use(
      http.post(`${API}/projects/:id/sql/versions/:versionId/approve`, () => {
        decided = true;
        return ok({ version: nowApproved });
      }),
      http.get(`${API}/projects/:id/sql/versions/:versionId`, ({ params }) => {
        if (params.versionId === APPROVED.id) return ok({ version: APPROVED });
        return ok({ version: decided ? nowApproved : PASSING_DRAFT });
      }),
      http.get(`${API}/projects/:id/sql/versions`, async () => {
        if (decided) await delay(300);
        const items = decided
          ? [nowApproved, { ...APPROVED, status: 'superseded' as const }]
          : [PASSING_DRAFT, APPROVED];
        return ok({ items: items.map(summary) });
      }),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'View version 5' }));
    await user.click(await screen.findByRole('button', { name: 'Approve version 5' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Approve version 5' })).not.toBeInTheDocument();
    });
    expect(
      await screen.findByText('Version 5 approved. It is now the current SQL.', undefined, {
        timeout: 2000,
      }),
    ).toBeInTheDocument();
  });

  it('rejects a draft with a reason', async () => {
    let body: unknown = null;
    setup();
    server.use(
      http.post(`${API}/projects/:id/sql/versions/:versionId/reject`, async ({ request }) => {
        body = await request.json();
        return ok({ version: { ...FAILED_DRAFT, status: 'rejected' } });
      }),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'View version 4' }));
    await user.click(await screen.findByRole('button', { name: 'Reject version 4' }));
    const dialog = screen.getByRole('dialog', { name: 'Reject version 4?' });
    await user.type(within(dialog).getByRole('textbox'), 'Duplicates in customer_id');
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(await screen.findByText('Version 4 rejected.')).toBeInTheDocument();
    expect(body).toEqual({ reason: 'Duplicates in customer_id' });
  });

  it('explains a refused approval in plain words', async () => {
    setup({ versions: [PASSING_DRAFT, APPROVED] });
    server.use(
      http.post(`${API}/projects/:id/sql/versions/:versionId/approve`, () =>
        fail(409, 'CONFLICT', 'Tests failed: row_count.', {
          reason: 'SQL_TESTS_FAILED',
          failedChecks: ['row_count'],
        }),
      ),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'View version 5' }));
    await user.click(await screen.findByRole('button', { name: 'Approve version 5' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('All tests must pass before approval.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve version 5' })).toBeInTheDocument();
  });

  it('runs the approved SQL and reports the new last run', async () => {
    const events = sseChannel();
    const bodies: unknown[] = [];
    let current = APPROVED;
    setup();
    server.use(
      acceptJobs(queuedJob('sql_run', { versionId: APPROVED.id }), bodies),
      http.get(`${API}/jobs/:id/events`, () => events.response()),
      http.get(`${API}/projects/:id/sql/versions/:versionId`, () => ok({ version: current })),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Run SQL version 3' }));
    await waitFor(() => {
      expect(bodies).toEqual([{ type: 'sql_run', payload: { versionId: APPROVED.id } }]);
    });
    const currentSql = section('Current SQL · version 3');
    events.send(jobFrame({ status: 'running', progress: 30 }));
    await waitFor(() => {
      expect(within(currentSql).getByRole('progressbar', { name: 'Run SQL' })).toHaveAttribute(
        'aria-valuenow',
        '30',
      );
    });
    expect(screen.getByRole('button', { name: 'Run SQL version 3' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );

    current = makeVersion({
      lastRun: { runId: 'r2', passed: false, rowCount: 4999, finishedAt: new Date().toISOString() },
    });
    events.send(
      jobFrame({
        status: 'succeeded',
        progress: 100,
        result: { passed: false, rowCount: 4999, failedChecks: ['row_count'] },
      }),
    );
    events.close();
    expect(
      await within(currentSql).findByText(
        'The SQL ran on 4,999 rows but some checks failed: Row count.',
      ),
    ).toBeInTheDocument();
    expect(await within(currentSql).findByText(/4,999 rows · failed/)).toBeInTheDocument();
  });
});

describe('pipeline: export actions and roles', () => {
  const XLSX_EXPORT: ExportView = {
    ...CSV_EXPORT,
    id: '64b0000000000000000000f2',
    format: 'xlsx',
    scope: 'all',
    includeSources: true,
    filename: 'customer-360-demo-2026-11-23.xlsx',
  };

  it('starts an export with the chosen options and lists it when ready', async () => {
    const events = sseChannel();
    const bodies: unknown[] = [];
    let exports = [CSV_EXPORT];
    setup({ member: 'data_steward' });
    server.use(
      acceptJobs(queuedJob('export', {}), bodies),
      http.get(`${API}/jobs/:id/events`, () => events.response()),
      http.get(`${API}/projects/:id/exports`, () => ok({ items: exports })),
    );
    const user = userEvent.setup();
    const trigger = await screen.findByRole('button', { name: 'New export' });
    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'New export' });
    expect(within(dialog).getByRole('radio', { name: 'CSV' })).toBeChecked();
    expect(within(dialog).getByRole('radio', { name: /Approved only/ })).toBeChecked();
    await user.click(within(dialog).getByRole('radio', { name: 'Excel' }));
    await user.click(within(dialog).getByRole('radio', { name: /All with review status/ }));
    await user.click(within(dialog).getByRole('checkbox', { name: /Include source record keys/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Start export' }));

    await waitFor(() => {
      expect(bodies).toEqual([
        { type: 'export', payload: { format: 'xlsx', scope: 'all', includeSources: true } },
      ]);
    });
    // Focus goes back to the button that opened the dialog; it cannot start another export now.
    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });
    expect(trigger).toHaveAttribute('aria-disabled', 'true');
    const exportsSection = section('Exports');
    expect(
      await within(exportsSection).findByRole('progressbar', { name: 'Export' }),
    ).toBeInTheDocument();
    // Stewards may start exports but only data engineers and up may cancel them.
    expect(within(exportsSection).queryByRole('button', { name: 'Cancel: Export' })).toBeNull();

    exports = [XLSX_EXPORT, CSV_EXPORT];
    events.send(jobFrame({ status: 'succeeded', progress: 100, result: { rowCount: 4987 } }));
    events.close();
    expect(
      await within(exportsSection).findByText(
        'Export ready: 4,987 rows. Download it from the list.',
      ),
    ).toBeInTheDocument();
    expect(
      await within(exportsSection).findByRole('button', {
        name: `Download ${XLSX_EXPORT.filename}`,
      }),
    ).toBeInTheDocument();
    expect(trigger).toBeEnabled();
  });

  it('explains an export the api refuses', async () => {
    setup();
    server.use(
      http.post(`${API}/projects/:id/jobs`, () =>
        fail(
          409,
          'CONFLICT',
          'The customers are out of date: the pairs were scored or reviewed again after grouping. Build clusters again first.',
          { reason: 'CLUSTERS_OUTDATED' },
        ),
      ),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New export' }));
    await user.click(screen.getByRole('button', { name: 'Start export' }));
    expect(
      await within(screen.getByRole('dialog')).findByText(/The customers are out of date/),
    ).toBeInTheDocument();
  });

  it('deletes an export after a confirm', async () => {
    let deleted = '';
    let exports = [CSV_EXPORT];
    setup();
    server.use(
      http.get(`${API}/projects/:id/exports`, () => ok({ items: exports })),
      http.delete(`${API}/projects/:id/exports/:exportId`, ({ params }) => {
        deleted = String(params.exportId);
        exports = [];
        return ok({ deleted: true });
      }),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: `Delete ${CSV_EXPORT.filename}` }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this export?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText(`Deleted ${CSV_EXPORT.filename}.`)).toBeInTheDocument();
    expect(deleted).toBe(CSV_EXPORT.id);
    expect(await screen.findByRole('heading', { name: 'No exports yet' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Exports' })).toHaveFocus();
  });

  it('offers every action to a data engineer', async () => {
    setup();
    expect(await screen.findByRole('button', { name: 'Draft SQL' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Run SQL version 3' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'New export' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: `Delete ${CSV_EXPORT.filename}` }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/You can view the SQL/)).not.toBeInTheDocument();
  });

  it('lets a data steward export but not work on the SQL or delete exports', async () => {
    setup({ member: 'data_steward' });
    expect(await screen.findByRole('button', { name: 'New export' })).toBeInTheDocument();
    expect(screen.getByText(/You can view the SQL, and start and download exports/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Draft SQL' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Run SQL/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete / })).not.toBeInTheDocument();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'View version 4' }));
    const details = await screen.findByRole('region', { name: 'Version 4 details' });
    expect(await within(details).findByText('Tests on the sample')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve version/ })).not.toBeInTheDocument();
  });

  it('keeps a viewer read-only', async () => {
    setup({ member: 'viewer' });
    expect(
      await screen.findByRole('button', { name: `Download ${CSV_EXPORT.filename}` }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New export' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Draft SQL' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Run SQL/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete / })).not.toBeInTheDocument();
  });

  it('shows a running export job from the list with its progress', async () => {
    setup({ jobs: [makeJob({ type: 'export', status: 'running', progress: 70, payload: {} })] });
    server.use(http.get(`${API}/jobs/:id/events`, () => sseChannel().response()));
    expect(await screen.findByRole('progressbar', { name: 'Export' })).toHaveAttribute(
      'aria-valuenow',
      '70',
    );
    expect(screen.getByRole('button', { name: 'New export' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});
