import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ExportView,
  ProjectRole,
  SqlCheck,
  SqlVersion,
  SqlVersionSummary,
} from '@/lib/api-types';
import { API, fail, makeProject, makeSession, ok, signedInHandlers } from '@/test/fixtures';
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
}

function setup({
  versions = [FAILED_DRAFT, APPROVED, OLD],
  exports = [CSV_EXPORT],
  member,
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
    setup();
    server.use(
      http.get(`${API}/projects/:id/exports/:exportId/download`, async ({ request }) => {
        auth = request.headers.get('Authorization');
        await delay(20);
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
