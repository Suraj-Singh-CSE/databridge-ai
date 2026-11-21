import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import type { Job, Project, ProjectRole, Source } from '@/lib/api-types';
import { installFakeXhr } from '@/test/fake-xhr';
import {
  API,
  fail,
  jobFrame,
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
const PATH = `/projects/${PROJECT_ID}/sources`;

function ownProject(): Project {
  return makeProject({ currentStep: 'sources', ownerId: USER_ID });
}

function memberProject(role: ProjectRole): Project {
  return makeProject({
    currentStep: 'sources',
    ownerId: '64b0000000000000000000ff',
    members: [{ userId: USER_ID, role }],
  });
}

interface Setup {
  project?: Project;
  sources?: Source[] | (() => Source[]);
  jobs?: Job[];
}

function setup({ project = ownProject(), sources = [], jobs = [] }: Setup = {}) {
  server.use(
    ...signedInHandlers(makeSession('data_engineer')),
    http.get(`${API}/projects/:id`, () => ok({ project })),
    http.get(`${API}/projects/:id/sources`, () =>
      ok({ items: typeof sources === 'function' ? sources() : sources }),
    ),
    http.get(`${API}/projects/:id/jobs`, () => ok({ items: jobs })),
  );
  return renderApp(PATH);
}

function row(fileName: string): HTMLElement {
  const cell = screen.getByText(fileName, { selector: 'td span' });
  const tr = cell.closest('tr');
  if (!tr) throw new Error('no row');
  return tr;
}

function fileInput(): HTMLInputElement {
  const input = screen.getByLabelText('Choose files to upload');
  if (!(input instanceof HTMLInputElement)) throw new Error('no input');
  return input;
}

describe('sources page', () => {
  it('lists files with format, size, rows × columns, time and a status in words', async () => {
    setup({
      sources: [
        makeSource(),
        makeSource({
          id: '64b0000000000000000000c2',
          originalFilename: 'billing_export.xlsx',
          format: 'xlsx',
          sizeBytes: 2.5 * 1024 * 1024,
          status: 'failed',
          rowCount: null,
          columnCount: null,
          error: { code: 'TOO_MANY_COLUMNS', message: 'Too many columns.' },
        }),
        makeSource({
          id: '64b0000000000000000000c3',
          originalFilename: 'support_contacts.csv',
          status: 'uploaded',
          sizeBytes: 900,
        }),
      ],
    });

    expect(await screen.findByRole('heading', { name: 'Add your source files' })).toBeVisible();
    const crm = within(await waitFor(() => row('crm_customers.csv')));
    expect(crm.getByText('CSV')).toBeInTheDocument();
    expect(crm.getByText('15 KB')).toBeInTheDocument();
    expect(crm.getByText('2,014 × 9')).toBeInTheDocument();
    expect(crm.getByText('5 min ago')).toBeInTheDocument();
    expect(crm.getByText('Profiled')).toBeInTheDocument();
    expect(crm.getByRole('button', { name: 'Re-run profile of crm_customers.csv' })).toBeEnabled();

    const billing = within(row('billing_export.xlsx'));
    expect(billing.getByText('Excel')).toBeInTheDocument();
    expect(billing.getByText('2.5 MB')).toBeInTheDocument();
    expect(billing.getByText('— × —')).toBeInTheDocument();
    expect(billing.getByText('Failed')).toBeInTheDocument();
    expect(billing.getByText(/too many columns to profile/)).toBeInTheDocument();

    const support = within(row('support_contacts.csv'));
    expect(support.getByText('Uploaded')).toBeInTheDocument();
    expect(support.getByRole('button', { name: 'Profile support_contacts.csv' })).toBeEnabled();

    expect(screen.getByText(/3 of 10 files used/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue to profiling' })).toHaveAttribute(
      'href',
      `/projects/${PROJECT_ID}/profile`,
    );
  });

  it('shows loading, then an empty state with the upload area', async () => {
    setup();
    server.use(
      http.get(`${API}/projects/:id/sources`, async () => {
        await delay(50);
        return ok({ items: [] });
      }),
    );

    expect(await screen.findByRole('status', { name: 'Loading files' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'No files yet' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Browse files' })).toBeEnabled();
    expect(screen.getByText(/CSV or Excel · up to 50 MB and 200,000 rows per file/)).toBeVisible();
  });

  it('shows an error with a working retry', async () => {
    let attempts = 0;
    setup();
    server.use(
      http.get(`${API}/projects/:id/sources`, () => {
        attempts += 1;
        return attempts === 1
          ? fail(500, 'INTERNAL_ERROR', 'Server trouble.')
          : ok({ items: [makeSource()] });
      }),
    );
    const user = userEvent.setup();

    expect(await screen.findByText(/We could not load the files/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('crm_customers.csv')).toBeInTheDocument();
  });

  it.each<ProjectRole>(['viewer', 'data_steward'])(
    'hides upload, profile and remove from a %s, with a short reason',
    async (role) => {
      setup({ project: memberProject(role), sources: [makeSource()] });

      await screen.findByText('crm_customers.csv');
      expect(screen.getByRole('note')).toHaveTextContent(
        'Only the project owner, an admin or a data engineer can upload, profile or remove them.',
      );
      expect(screen.queryByRole('button', { name: 'Browse files' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /profile/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Preview crm_customers.csv' })).toBeEnabled();
    },
  );

  it('lets a data engineer member manage files', async () => {
    setup({ project: memberProject('data_engineer'), sources: [makeSource()] });

    expect(await screen.findByRole('button', { name: 'Remove crm_customers.csv' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Browse files' })).toBeEnabled();
  });

  it('turns away wrong file types before uploading', async () => {
    const requests = installFakeXhr();
    setup();
    const user = userEvent.setup({ applyAccept: false });
    await screen.findByRole('heading', { name: 'No files yet' });

    await user.upload(fileInput(), new File(['%PDF'], 'notes.pdf', { type: 'application/pdf' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '"notes.pdf" is not a CSV or Excel (.xlsx) file.',
    );
    expect(requests).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('stops at the 10-file limit', async () => {
    const many = Array.from({ length: 10 }, (_, index) =>
      makeSource({
        id: `64b0000000000000000001${String(index).padStart(2, '0')}`,
        originalFilename: `file_${index}.csv`,
      }),
    );
    setup({ sources: many });

    await screen.findByText('file_9.csv');
    expect(screen.getByRole('button', { name: 'Browse files' })).toBeDisabled();
    expect(screen.getByText(/This project has 10 files, the most allowed/)).toBeInTheDocument();
  });

  it('uploads with progress, starts profiling and follows it live until profiled', async () => {
    const requests = installFakeXhr();
    const uploaded = makeSource({ status: 'uploaded' });
    let current: Source[] = [];
    const events = sseChannel();
    let jobBody: unknown = null;
    setup({ sources: () => current });
    server.use(
      http.post(`${API}/projects/:id/jobs`, async ({ request }) => {
        jobBody = await request.json();
        return ok({ job: makeJob({ status: 'queued', progress: 0, message: '' }) }, 202);
      }),
      http.get(`${API}/jobs/:id/events`, () => events.response()),
    );
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'No files yet' });

    await user.upload(fileInput(), new File(['a,b\n1,2\n'], 'crm_customers.csv'));
    const xhr = requests[0];
    if (!xhr) throw new Error('no upload request');
    const form = xhr.body;
    if (!(form instanceof FormData)) throw new Error('expected multipart form data');
    expect(form.get('file')).toBeInstanceOf(File);

    xhr.progress(40, 100);
    const uploads = await screen.findByRole('list', { name: 'Uploads in progress' });
    expect(within(uploads).getByText('Uploading 40%')).toBeInTheDocument();
    expect(within(uploads).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');

    current = [uploaded];
    xhr.respond(201, { data: { source: uploaded }, error: null });

    await waitFor(() => {
      expect(jobBody).toEqual({ type: 'profile', payload: { sourceId: uploaded.id } });
    });
    expect(await screen.findByText('Waiting to start')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Uploads in progress' })).not.toBeInTheDocument();

    events.send(jobFrame({ status: 'running', progress: 64, message: 'Profiled column 6 of 9' }));
    expect(await screen.findByText('Profiling 64%')).toBeInTheDocument();
    expect(screen.getByText('Profiled column 6 of 9')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Cancel profiling of crm_customers.csv' }),
    ).toBeEnabled();

    current = [makeSource()];
    events.send(jobFrame({ status: 'succeeded', progress: 100, message: 'Done' }));
    events.close();
    expect(await screen.findByText('Profiled')).toBeInTheDocument();
    expect(screen.queryByText(/Profiling \d+%/)).not.toBeInTheDocument();
  });

  it('shows a friendly message for a server error code', async () => {
    const requests = installFakeXhr();
    setup({ sources: [makeSource()] });
    const user = userEvent.setup();
    await screen.findByText('crm_customers.csv', { selector: 'td span' });

    await user.upload(fileInput(), new File(['a,b\n1,2\n'], 'copy.csv'));
    requests[0]?.respond(409, {
      data: null,
      error: { code: 'CONFLICT', message: 'This file is already in the project.', details: null },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'copy.csv: This file is already in the project.',
    );
  });

  it('cancels an upload', async () => {
    const requests = installFakeXhr();
    setup();
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'No files yet' });

    await user.upload(fileInput(), new File(['a\n1\n'], 'slow.csv'));
    await user.click(await screen.findByRole('button', { name: 'Cancel upload of slow.csv' }));

    expect(requests[0]?.aborted).toBe(true);
    await waitFor(() => {
      expect(screen.queryByRole('list', { name: 'Uploads in progress' })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a running job and cancels it', async () => {
    const events = sseChannel();
    let cancelled = false;
    setup({ sources: [makeSource({ status: 'profiling' })], jobs: [makeJob()] });
    server.use(
      http.get(`${API}/jobs/:id/events`, () => events.response()),
      http.post(`${API}/jobs/:id/cancel`, () => {
        cancelled = true;
        return ok({ job: makeJob({ status: 'cancelled' }) });
      }),
    );
    const user = userEvent.setup();

    expect(await screen.findByText('Profiling 40%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove crm_customers.csv' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Cancel profiling of crm_customers.csv' }));

    await waitFor(() => {
      expect(cancelled).toBe(true);
    });
    expect(
      await screen.findByRole('button', { name: 'Profile crm_customers.csv' }),
    ).toBeInTheDocument();
  });

  it('re-runs a profile and explains when one is already running', async () => {
    setup({ sources: [makeSource()] });
    server.use(
      http.post(`${API}/projects/:id/jobs`, () =>
        fail(409, 'CONFLICT', 'This source is already being profiled.'),
      ),
    );
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole('button', { name: 'Re-run profile of crm_customers.csv' }),
    );
    expect(
      await screen.findByText('crm_customers.csv: This file is already being profiled.'),
    ).toBeInTheDocument();
  });

  it('previews the first rows in a dialog', async () => {
    setup({ sources: [makeSource()] });
    server.use(
      http.get(`${API}/projects/:id/sources/:sourceId/preview`, ({ request }) => {
        expect(new URL(request.url).searchParams.get('limit')).toBe('20');
        return ok({ columns: ['cust_id', 'city'], rows: [['C000001', 'Pune']] });
      }),
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Preview crm_customers.csv' }));
    const dialog = await screen.findByRole('dialog', { name: 'Preview · crm_customers.csv' });
    expect(await within(dialog).findByRole('columnheader', { name: 'cust_id' })).toBeVisible();
    expect(within(dialog).getByRole('cell', { name: 'Pune' })).toBeVisible();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('removes a file after confirmation', async () => {
    let current = [makeSource()];
    let deleted = '';
    setup({ sources: () => current });
    server.use(
      http.delete(`${API}/projects/:id/sources/:sourceId`, ({ params }) => {
        deleted = String(params.sourceId);
        current = [];
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Remove crm_customers.csv' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove this file?' });
    await user.click(within(dialog).getByRole('button', { name: 'Remove file' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(deleted).toBe('64b0000000000000000000c1');
    expect(await screen.findByRole('heading', { name: 'No files yet' })).toBeInTheDocument();
  });

  it('keeps the dialog open with a reason when removing fails', async () => {
    setup({ sources: [makeSource()] });
    server.use(
      http.delete(`${API}/projects/:id/sources/:sourceId`, () =>
        fail(403, 'FORBIDDEN', 'You do not have permission to do this.'),
      ),
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Remove crm_customers.csv' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove this file?' });
    await user.click(within(dialog).getByRole('button', { name: 'Remove file' }));

    expect(
      await within(dialog).findByText(
        'You do not have permission to remove files from this project.',
      ),
    ).toBeInTheDocument();
  });
});
