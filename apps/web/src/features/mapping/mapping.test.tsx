import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http } from 'msw';
import { describe, expect, it } from 'vitest';

import type {
  ColumnMapping,
  MappingSuggestion,
  Source,
  SourceMappings,
  TargetSchema,
} from '@/lib/api-types';
import {
  API,
  fail,
  makeProject,
  makeSession,
  makeSource,
  ok,
  signedInHandlers,
} from '@/test/fixtures';
import { renderApp } from '@/test/render-app';
import { server } from '@/test/server';

import { transformLabel } from './mapping-labels';

const PROJECT_ID = '64b0000000000000000000a1';
const CRM_ID = '64b0000000000000000000c1';
const BILLING_ID = '64b0000000000000000000c2';
const PATH = `/projects/${PROJECT_ID}/mapping`;

const RUN = {
  jobId: '64b0000000000000000000d1',
  runId: 'run-1',
  schemaVersion: 1,
  method: 'hybrid' as const,
  model: 'mock',
  createdAt: '2026-11-21T10:10:00.000Z',
};

function suggestion(overrides: Partial<MappingSuggestion> = {}): MappingSuggestion {
  return {
    target: 'full_name',
    role: 'field',
    confidence: 0.97,
    confidenceLabel: 'High',
    reason: 'The column name matches “full_name”.',
    transform: 'title_case',
    alternatives: [],
    ...overrides,
  };
}

function column(
  name: string,
  position: number,
  s: MappingSuggestion,
  extra: Partial<ColumnMapping> = {},
): ColumnMapping {
  return { column: name, position, suggestion: s, decision: null, status: 'pending', ...extra };
}

const COLUMNS: ColumnMapping[] = [
  column(
    'cust_id',
    0,
    suggestion({
      target: null,
      role: 'source_record_id',
      confidence: 0.92,
      reason: 'Unique on every row: keep it to trace records back to this source.',
      transform: null,
    }),
  ),
  column(
    'cust_nm',
    1,
    suggestion({
      alternatives: [
        { target: 'first_name', role: 'field', confidence: 0.41 },
        { target: null, role: 'ignore', confidence: 0.1 },
      ],
    }),
    {
      status: 'accepted',
      decision: {
        column: 'cust_nm',
        decision: 'accept',
        target: 'full_name',
        role: 'field',
        transform: 'title_case',
        schemaVersion: 1,
        decidedBy: 'u1',
        decidedAt: '2026-11-21T10:20:00.000Z',
      },
    },
  ),
  column(
    'mobile_no',
    2,
    suggestion({
      target: 'phone',
      confidence: 0.78,
      confidenceLabel: 'Medium',
      reason: 'Values look like Indian mobile numbers.',
      transform: 'to_e164_in',
    }),
  ),
  column(
    'dob',
    3,
    suggestion({
      target: 'date_of_birth',
      confidence: 0.72,
      confidenceLabel: 'Medium',
      reason: 'DD/MM/YYYY dates.',
      transform: 'parse_date:DD/MM/YYYY',
    }),
  ),
  column(
    'ticket_ref',
    4,
    suggestion({
      target: null,
      role: 'ignore',
      confidence: 0.31,
      confidenceLabel: 'Low',
      reason: 'No target field fits ticket numbers.',
      transform: null,
    }),
  ),
];

function mappingsOf(overrides: Partial<SourceMappings> = {}): SourceMappings {
  return {
    source: { id: CRM_ID, name: 'crm_customers', status: 'profiled' },
    schemaVersion: 1,
    run: RUN,
    stale: false,
    columns: COLUMNS,
    summary: { total: 5, high: 2, medium: 2, low: 1, decided: 1 },
    ...overrides,
  };
}

const SCHEMA: TargetSchema = {
  name: 'Customer 360',
  version: 1,
  fields: [
    {
      name: 'full_name',
      type: 'string',
      format: null,
      description: 'Customer full name',
      isPii: true,
      generated: false,
      required: true,
      allowConcat: true,
    },
    {
      name: 'phone',
      type: 'string',
      format: '+91XXXXXXXXXX',
      description: 'Mobile number in E.164',
      isPii: true,
      generated: false,
      required: false,
      allowConcat: false,
    },
  ],
  updatedBy: null,
  updatedAt: '2026-11-01T10:00:00.000Z',
};

interface Setup {
  sources?: Source[];
  mappings?: Record<string, SourceMappings>;
  mappingsError?: boolean;
}

function setup({ sources = [makeSource()], mappings, mappingsError = false }: Setup = {}) {
  const byId = mappings ?? { [CRM_ID]: mappingsOf() };
  server.use(
    ...signedInHandlers(makeSession('data_steward')),
    http.get(`${API}/projects/:id`, () => ok({ project: makeProject() })),
    http.get(`${API}/projects/:id/sources`, () => ok({ items: sources })),
    http.get(`${API}/projects/:id/target-schema`, () => ok({ schema: SCHEMA })),
    http.get(`${API}/projects/:id/sources/:sourceId/mappings`, async ({ params }) => {
      if (mappingsError) {
        await delay(50);
        return fail(500, 'INTERNAL', 'Something went wrong.');
      }
      const found = byId[String(params.sourceId)];
      return found ? ok(found) : fail(404, 'NOT_FOUND', 'Source not found.');
    }),
  );
  return renderApp(PATH);
}

function rowOf(name: string): HTMLElement {
  const row = screen.getByRole('button', { name: `${name}, other possible fields` }).closest('tr');
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

function columnNames(): string[] {
  return screen.getAllByRole('rowheader').map((cell) => cell.textContent);
}

describe('mapping page', () => {
  it('shows a row per column with field, confidence, reason, cleaning and status', async () => {
    setup();

    expect(await screen.findByRole('heading', { name: 'Columns that match' })).toBeVisible();
    await screen.findByRole('table', { name: 'Column mapping suggestions' });
    expect(columnNames()).toEqual(['cust_id', 'cust_nm', 'mobile_no', 'dob', 'ticket_ref']);

    const name = within(rowOf('cust_nm'));
    expect(name.getByText('full_name')).toBeInTheDocument();
    expect(name.getByText('Customer full name')).toBeInTheDocument();
    expect(name.getByText('High · 97%')).toBeInTheDocument();
    expect(name.getByText('The column name matches “full_name”.')).toBeInTheDocument();
    expect(name.getByText('Capitalise each word')).toBeInTheDocument();
    expect(name.getByText('Accepted')).toBeInTheDocument();

    const phone = within(rowOf('mobile_no'));
    expect(phone.getByText('Medium · 78%')).toBeInTheDocument();
    expect(phone.getByText('Format as +91 phone')).toBeInTheDocument();
    expect(phone.getByText('Mobile number in E.164')).toBeInTheDocument();
    expect(phone.getByText('Pending')).toBeInTheDocument();

    expect(within(rowOf('dob')).getByText('Read dates as DD/MM/YYYY')).toBeInTheDocument();

    const ticket = within(rowOf('ticket_ref'));
    expect(ticket.getByText('Not mapped')).toBeInTheDocument();
    expect(ticket.getByText('Low · 31%')).toBeInTheDocument();
    expect(ticket.getByText('None')).toBeInTheDocument();

    const id = within(rowOf('cust_id'));
    expect(id.getByText('Record ID')).toBeInTheDocument();
    expect(id.getByText('Kept to trace records back to this file')).toBeInTheDocument();
  });

  it('shows the summary counts and the method', async () => {
    setup();

    await screen.findByRole('table', { name: 'Column mapping suggestions' });
    expect(screen.getByText('Columns').nextSibling).toHaveTextContent('5');
    expect(screen.getByText('High confidence').nextSibling).toHaveTextContent('2');
    expect(screen.getByText('Medium confidence').nextSibling).toHaveTextContent('2');
    expect(screen.getByText('Low confidence').nextSibling).toHaveTextContent('1');
    expect(screen.getByText(/1 decided · 4 pending/)).toBeInTheDocument();
    expect(screen.getByText('AI + rules')).toBeInTheDocument();
    expect(screen.queryByText(/target schema changed/)).not.toBeInTheDocument();
  });

  it('says when only rules were used and when the schema changed since', async () => {
    setup({
      mappings: { [CRM_ID]: mappingsOf({ run: { ...RUN, method: 'rules' }, stale: true }) },
    });

    expect(
      await screen.findByText('The target schema changed after these suggestions were made'),
    ).toBeInTheDocument();
    expect(screen.getByText('Rules only')).toBeInTheDocument();
    expect(screen.getByText(/only rules were used/)).toBeInTheDocument();
  });

  it('expands a row with the keyboard to show the alternatives', async () => {
    setup();
    const user = userEvent.setup();

    const toggle = await screen.findByRole('button', { name: 'cust_nm, other possible fields' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    toggle.focus();
    await user.keyboard('{Enter}');

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const details = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    if (!details) throw new Error('no details row');
    const panel = within(details);
    expect(panel.getByText('first_name')).toBeInTheDocument();
    expect(panel.getByText('41%')).toBeInTheDocument();
    expect(panel.getByText('Not mapped')).toBeInTheDocument();
    expect(panel.getByText('10%')).toBeInTheDocument();

    await user.keyboard(' ');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('filters by confidence, status and search, announcing the count', async () => {
    setup();
    const user = userEvent.setup();
    await screen.findByRole('table', { name: 'Column mapping suggestions' });

    const confidence = screen.getByRole('group', { name: 'Confidence' });
    await user.click(within(confidence).getByRole('button', { name: 'Medium' }));
    expect(columnNames()).toEqual(['mobile_no', 'dob']);
    expect(screen.getByText('Showing 2 of 5 columns')).toHaveAttribute('aria-live', 'polite');

    await user.click(within(confidence).getByRole('button', { name: 'All' }));
    const status = screen.getByRole('group', { name: 'Status' });
    await user.click(within(status).getByRole('button', { name: 'Decided' }));
    expect(columnNames()).toEqual(['cust_nm']);
    await user.click(within(status).getByRole('button', { name: 'Pending' }));
    expect(columnNames()).toEqual(['cust_id', 'mobile_no', 'dob', 'ticket_ref']);

    await user.type(screen.getByRole('searchbox', { name: 'Search columns' }), 'MOB');
    expect(columnNames()).toEqual(['mobile_no']);

    await user.type(screen.getByRole('searchbox', { name: 'Search columns' }), 'zzz');
    expect(screen.getByRole('heading', { name: 'No matching columns' })).toBeInTheDocument();
    expect(screen.getByText('Showing 0 of 5 columns')).toBeInTheDocument();
  });

  it('lets you pick a profiled file and disables the others', async () => {
    const billing = makeSource({ id: BILLING_ID, originalFilename: 'billing.csv' });
    const pending = makeSource({
      id: '64b0000000000000000000c3',
      originalFilename: 'support.csv',
      status: 'uploaded',
    });
    setup({
      sources: [makeSource(), billing, pending],
      mappings: {
        [CRM_ID]: mappingsOf(),
        [BILLING_ID]: mappingsOf({
          source: { id: BILLING_ID, name: 'billing', status: 'profiled' },
          columns: COLUMNS.filter((c) => c.column === 'mobile_no'),
          summary: { total: 1, high: 0, medium: 1, low: 0, decided: 0 },
        }),
      },
    });
    const user = userEvent.setup();

    const picker = await screen.findByRole('group', { name: 'Choose a file' });
    expect(within(picker).getByRole('button', { name: /support\.csv/ })).toBeDisabled();
    expect(within(picker).getByText('· Profile this file first')).toBeInTheDocument();
    await screen.findByRole('table', { name: 'Column mapping suggestions' });

    await user.click(within(picker).getByRole('button', { name: /billing\.csv/ }));
    await waitFor(() => {
      expect(columnNames()).toEqual(['mobile_no']);
    });
  });

  it('says when there are no files yet', async () => {
    setup({ sources: [] });
    expect(await screen.findByRole('heading', { name: 'No files to map yet' })).toBeInTheDocument();
  });

  it('asks to profile a file that is not profiled yet', async () => {
    setup({ sources: [makeSource({ status: 'uploaded' })] });
    expect(
      await screen.findByRole('heading', { name: 'Profile this file first' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Profile' })).toHaveAttribute(
      'href',
      `/projects/${PROJECT_ID}/profile`,
    );
  });

  it('explains that suggestions come after mapping runs', async () => {
    setup({
      mappings: {
        [CRM_ID]: mappingsOf({
          run: null,
          columns: [],
          summary: { total: 0, high: 0, medium: 0, low: 0, decided: 0 },
        }),
      },
    });
    expect(await screen.findByRole('heading', { name: 'No suggestions yet' })).toBeInTheDocument();
    expect(
      screen.getByText('Suggestions will appear here after mapping runs.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /run/i })).not.toBeInTheDocument();
  });

  it('says when mapping found no columns', async () => {
    setup({
      mappings: {
        [CRM_ID]: mappingsOf({
          columns: [],
          summary: { total: 0, high: 0, medium: 0, low: 0, decided: 0 },
        }),
      },
    });
    expect(await screen.findByRole('heading', { name: 'No columns to map' })).toBeInTheDocument();
  });

  it('shows loading, then an error with a retry', async () => {
    setup({ mappingsError: true });
    expect(await screen.findByRole('status', { name: 'Loading suggestions' })).toBeInTheDocument();
    expect(await screen.findByText(/We could not load the suggestions/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('shows an error when the files cannot be loaded', async () => {
    setup();
    server.use(http.get(`${API}/projects/:id/sources`, () => fail(500, 'INTERNAL', 'Down.')));
    expect(await screen.findByText(/We could not load the files/)).toBeInTheDocument();
  });
});

describe('transformLabel', () => {
  it.each([
    [null, 'None'],
    ['to_e164_in', 'Format as +91 phone'],
    ['lowercase', 'Make lowercase'],
    ['digits_only', 'Keep digits only'],
    ['parse_date:YYYY-MM-DD', 'Read dates as YYYY-MM-DD'],
    ['concat', 'Join with the other name parts'],
    ['split_name', 'Split the full name'],
    ['trim', 'Trim extra spaces'],
    ['something_new', 'something_new'],
  ])('%s -> %s', (code, label) => {
    expect(transformLabel(code)).toBe(label);
  });
});
