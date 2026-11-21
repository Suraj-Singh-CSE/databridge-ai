import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { describe, expect, it } from 'vitest';

import type { ColumnProfile, Job, Project, Source } from '@/lib/api-types';
import {
  API,
  fail,
  jobFrame,
  makeColumn,
  makeJob,
  makeProject,
  makeSession,
  makeSource,
  ok,
  signedInHandlers,
  sseChannel,
} from '@/test/fixtures';
import { renderApp } from '@/test/render-app';
import { server } from '@/test/server';

const USER_ID = '64b000000000000000000001';
const PROJECT_ID = '64b0000000000000000000a1';
const BILLING_ID = '64b0000000000000000000c2';

const COLUMNS: ColumnProfile[] = [
  makeColumn(),
  makeColumn({
    column: 'email_id',
    position: 1,
    inferredType: 'email',
    emptyCount: 280,
    emptyPercent: 13.9,
    distinctCount: 1700,
    uniquePercent: 99.04,
    topValues: [{ value: '[EMAIL]', count: 1734, percent: 86.1 }],
    samples: ['[EMAIL]'],
    patterns: [{ code: 'email', label: 'Email address', matchCount: 1734, matchPercent: 100 }],
    flags: [
      { code: 'PERSONAL_DATA', label: 'Personal data', detail: 'Values are masked.' },
      { code: 'EXTRA_SPACES', label: 'Extra spaces', detail: '12 values have extra spaces.' },
    ],
    personal: true,
  }),
  makeColumn({
    column: 'dob',
    position: 2,
    inferredType: 'date',
    emptyCount: 600,
    emptyPercent: 29.8,
    uniquePercent: 91.2,
    samples: ['99/99/9999'],
    patterns: [{ code: 'date_dmy', label: 'DD/MM/YYYY', matchCount: 1300, matchPercent: 92.1 }],
    flags: [{ code: 'HIGH_EMPTY_RATE', label: 'High empty rate', detail: '29.8% of rows.' }],
    personal: true,
  }),
  makeColumn({
    column: 'city',
    position: 3,
    emptyPercent: 2,
    uniquePercent: 3.1,
    min: null,
    max: null,
    topValues: [{ value: 'Pune', count: 300, percent: 14.9 }],
    samples: ['Pune', 'Mumbai'],
    flags: [],
  }),
];

interface Setup {
  project?: Project;
  sources?: Source[];
  jobs?: Job[];
  profiles?: Record<string, { source: Source; columns: ColumnProfile[] }>;
  path?: string;
}

function setup({
  project = makeProject({ currentStep: 'profile', ownerId: USER_ID }),
  sources = [makeSource()],
  jobs = [],
  profiles,
  path = `/projects/${PROJECT_ID}/profile`,
}: Setup = {}) {
  const byId = profiles ?? { [makeSource().id]: { source: makeSource(), columns: COLUMNS } };
  server.use(
    ...signedInHandlers(makeSession('data_engineer')),
    http.get(`${API}/projects/:id`, () => ok({ project })),
    http.get(`${API}/projects/:id/sources`, () => ok({ items: sources })),
    http.get(`${API}/projects/:id/jobs`, () => ok({ items: jobs })),
    http.get(`${API}/projects/:id/sources/:sourceId/profile`, ({ params }) => {
      const profile = byId[String(params.sourceId)];
      return profile ? ok(profile) : fail(404, 'NOT_FOUND', 'Source not found.');
    }),
  );
  return renderApp(path);
}

function columnNames(): string[] {
  return screen.getAllByRole('rowheader').map((cell) => cell.textContent);
}

describe('profile page', () => {
  it('shows summary cards and a row per column with type, empty, unique, patterns and flags', async () => {
    setup();

    expect(await screen.findByRole('heading', { name: "What's in your data" })).toBeVisible();
    await screen.findByRole('table', { name: 'Column profile' });
    expect(screen.getByText('Rows').nextSibling).toHaveTextContent('2,014');
    expect(screen.getByText('Columns').nextSibling).toHaveTextContent('4');
    expect(screen.getByText('Columns with issues').nextSibling).toHaveTextContent('2');
    expect(columnNames()).toEqual(['cust_id', 'email_id', 'dob', 'city']);

    const emailRow = screen.getByRole('button', { name: 'email_id, details' }).closest('tr');
    if (!emailRow) throw new Error('no row');
    const email = within(emailRow);
    expect(email.getByText('Email')).toBeInTheDocument();
    expect(email.getByText('13.9%')).toBeInTheDocument();
    expect(email.getByText('99%')).toBeInTheDocument();
    expect(email.getByText('Email address')).toBeInTheDocument();
    expect(email.getByText('100%')).toBeInTheDocument();
    expect(email.getByText('Personal data')).toBeInTheDocument();
    expect(email.getByText('Extra spaces')).toBeInTheDocument();
    expect(screen.getByText('File:').nextSibling).toHaveTextContent('crm_customers.csv');
    expect(screen.getByRole('link', { name: 'Continue to mapping' })).toBeInTheDocument();
  });

  it('expands a row to show ranges, top values and masked samples exactly as sent', async () => {
    setup();
    const user = userEvent.setup();

    const toggle = await screen.findByRole('button', { name: 'email_id, details' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const details = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    if (!details) throw new Error('no details row');
    const panel = within(details);
    expect(panel.getAllByText('Hidden (personal data)')).toHaveLength(2);
    expect(panel.getByText('7 to 7 characters (average 7)')).toBeInTheDocument();
    expect(panel.getByText('1,734 · 86.1%')).toBeInTheDocument();
    expect(
      within(panel.getByRole('list', { name: 'Masked samples of email_id' })).getByText('[EMAIL]'),
    ).toBeInTheDocument();
    expect(panel.getByText(/Extra spaces:/)).toBeInTheDocument();

    await user.click(toggle);
    expect(details).not.toBeInTheDocument();
  });

  it('filters by name and by issues, and sorts by empty values', async () => {
    setup();
    const user = userEvent.setup();
    await screen.findByRole('table', { name: 'Column profile' });

    await user.type(screen.getByLabelText('Search columns'), 'ID');
    expect(columnNames()).toEqual(['cust_id', 'email_id']);
    expect(screen.getByText('Showing 2 of 4 columns')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Search columns'));
    await user.click(screen.getByLabelText('Only columns with issues'));
    expect(columnNames()).toEqual(['email_id', 'dob']);
    await user.click(screen.getByLabelText('Only columns with issues'));

    const sortButton = screen.getByRole('button', { name: 'Empty, sort by empty values' });
    await user.click(sortButton);
    expect(sortButton.closest('th')).toHaveAttribute('aria-sort', 'descending');
    expect(columnNames()).toEqual(['dob', 'email_id', 'city', 'cust_id']);
    await user.click(sortButton);
    expect(columnNames()).toEqual(['cust_id', 'city', 'email_id', 'dob']);
    await user.click(sortButton);
    expect(sortButton.closest('th')).toHaveAttribute('aria-sort', 'none');

    await user.type(screen.getByLabelText('Search columns'), 'zzz');
    expect(screen.getByRole('heading', { name: 'No matching columns' })).toBeInTheDocument();
  });

  it('switches between files with the picker', async () => {
    const billing = makeSource({
      id: BILLING_ID,
      originalFilename: 'billing_export.xlsx',
      format: 'xlsx',
      columnCount: 1,
      rowCount: 151,
    });
    const { router } = setup({
      sources: [makeSource(), billing],
      profiles: {
        [makeSource().id]: { source: makeSource(), columns: COLUMNS },
        [BILLING_ID]: { source: billing, columns: [makeColumn({ column: 'PAN' })] },
      },
    });
    const user = userEvent.setup();

    const picker = await screen.findByRole('group', { name: 'Choose a file' });
    expect(within(picker).getByRole('button', { name: /crm_customers\.csv/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(within(picker).getByRole('button', { name: /billing_export\.xlsx/ }));

    expect(await screen.findByRole('button', { name: 'PAN, details' })).toBeInTheDocument();
    expect(router.state.location.search).toBe(`?source=${BILLING_ID}`);
    expect(screen.getByText('Rows').nextSibling).toHaveTextContent('151');
  });

  it('offers "Profile now" for a file that was not profiled yet', async () => {
    const source = makeSource({ status: 'uploaded', rowCount: null, columnCount: null });
    const events = sseChannel();
    let started: unknown = null;
    setup({
      sources: [source],
      profiles: { [source.id]: { source, columns: [] } },
    });
    server.use(
      http.post(`${API}/projects/:id/jobs`, async ({ request }) => {
        started = await request.json();
        return ok({ job: makeJob({ status: 'queued', progress: 0, message: '' }) }, 202);
      }),
      http.get(`${API}/jobs/:id/events`, () => events.response()),
    );
    const user = userEvent.setup();

    expect(await screen.findByRole('heading', { name: 'Not profiled yet' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Profile now' }));

    await waitFor(() => {
      expect(started).toEqual({ type: 'profile', payload: { sourceId: source.id } });
    });
    expect(await screen.findByText('Waiting to profile crm_customers.csv')).toBeInTheDocument();
    events.send(jobFrame({ status: 'running', progress: 15, message: 'Read 2,014 rows' }));
    expect(await screen.findByText('Profiling crm_customers.csv: 15%')).toBeInTheDocument();
    expect(screen.getByText('Read 2,014 rows')).toBeInTheDocument();
    expect(
      screen.getByRole('progressbar', { name: 'Profiling crm_customers.csv' }),
    ).toHaveAttribute('aria-valuenow', '15');
  });

  it('shows live progress for a running job and loads the profile when it finishes', async () => {
    const events = sseChannel();
    let finished = false;
    const source = makeSource({ status: 'profiling' });
    setup({ sources: [source], jobs: [makeJob()] });
    server.use(
      http.get(`${API}/jobs/:id/events`, () => events.response()),
      http.get(`${API}/projects/:id/jobs`, () =>
        ok({ items: [makeJob(finished ? { status: 'succeeded', progress: 100 } : {})] }),
      ),
      http.get(`${API}/projects/:id/sources/:sourceId/profile`, () =>
        ok(finished ? { source: makeSource(), columns: COLUMNS } : { source, columns: [] }),
      ),
    );

    expect(await screen.findByText('Profiling crm_customers.csv: 40%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel profiling' })).toBeEnabled();

    finished = true;
    events.send(jobFrame({ status: 'succeeded', progress: 100, message: 'Done' }));
    events.close();
    expect(await screen.findByRole('table', { name: 'Column profile' })).toBeInTheDocument();
  });

  it('explains a failed profile by its error code', async () => {
    const source = makeSource({
      status: 'failed',
      error: { code: 'FILE_TOO_COMPLEX', message: 'Raw text from the worker.' },
    });
    setup({ sources: [source], profiles: { [source.id]: { source, columns: [] } } });

    expect(await screen.findByText('Profiling failed')).toBeInTheDocument();
    expect(screen.getByText(/too large once unpacked/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  it('hides "Profile now" from a viewer and says who can profile', async () => {
    const source = makeSource({ status: 'uploaded' });
    setup({
      project: makeProject({
        ownerId: '64b0000000000000000000ff',
        members: [{ userId: USER_ID, role: 'viewer' }],
      }),
      sources: [source],
      profiles: { [source.id]: { source, columns: [] } },
    });

    expect(await screen.findByRole('heading', { name: 'Not profiled yet' })).toBeInTheDocument();
    expect(screen.getByText(/Ask the project owner or a data engineer/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Profile now' })).not.toBeInTheDocument();
  });

  it('points to Sources when the project has no files', async () => {
    setup({ sources: [] });

    expect(
      await screen.findByRole('heading', { name: 'No files to profile yet' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Sources' })).toHaveAttribute(
      'href',
      `/projects/${PROJECT_ID}/sources`,
    );
  });

  it('reports a profile that cannot be loaded', async () => {
    setup();
    server.use(
      http.get(`${API}/projects/:id/sources/:sourceId/profile`, () =>
        fail(500, 'INTERNAL_ERROR', 'Server trouble.'),
      ),
    );

    await waitFor(
      () => {
        expect(screen.getByText(/We could not load the profile/)).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
  });
});
