import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http } from 'msw';
import { describe, expect, it } from 'vitest';

import type { Project, Role } from '@/lib/api-types';
import { API, fail, makeProject, makeSession, ok, page, signedInHandlers } from '@/test/fixtures';
import { renderApp } from '@/test/render-app';
import { server } from '@/test/server';

/** Narrows a DOM query result, failing the test clearly if it is missing. */
function element(node: Element | null): HTMLElement {
  if (!(node instanceof HTMLElement)) throw new Error('Expected an element');
  return node;
}

function listReturns(items: Project[], role: Role = 'data_engineer') {
  server.use(
    ...signedInHandlers(makeSession(role)),
    http.get(`${API}/projects`, () => ok(page(items))),
  );
}

describe('projects page', () => {
  it('shows skeleton cards while loading', async () => {
    server.use(
      ...signedInHandlers(),
      http.get(`${API}/projects`, async () => {
        await delay(100);
        return ok(page([]));
      }),
    );
    renderApp('/projects');

    expect(await screen.findByRole('status', { name: 'Loading projects' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'No projects yet' })).toBeInTheDocument();
  });

  it('shows an empty state with a way to start', async () => {
    listReturns([]);
    renderApp('/projects');

    const empty = await screen.findByRole('heading', { name: 'No projects yet' });
    expect(empty.parentElement).toHaveTextContent('Create a project');
    expect(screen.getAllByRole('button', { name: 'New project' })).toHaveLength(2);
  });

  it('renders a card per project with step, progress and last update', async () => {
    listReturns([
      makeProject(),
      makeProject({
        id: '64b0000000000000000000a2',
        name: 'Vendor cleanup',
        status: 'archived',
        currentStep: 'sources',
        updatedAt: new Date(Date.now() - 26 * 3600_000).toISOString(),
      }),
    ]);
    renderApp('/projects');

    const first = (await screen.findByRole('heading', { name: 'Customer 360 demo' })).closest('a');
    expect(first).toHaveAttribute('href', '/projects/64b0000000000000000000a1/sources');
    const card = within(element(first));
    expect(card.getByText('In progress')).toBeInTheDocument();
    expect(card.getByText('No sources yet')).toBeInTheDocument();
    expect(card.getByText('Step 3 of 6 · Mapping')).toBeInTheDocument();
    expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    expect(card.getByText('Updated 2 min ago')).toBeInTheDocument();

    const second = within(
      element(screen.getByRole('heading', { name: 'Vendor cleanup' }).closest('a')),
    );
    expect(second.getByText('Archived')).toBeInTheDocument();
    expect(second.getByText('Step 1 of 6 · Sources')).toBeInTheDocument();
    expect(second.getByText('Updated yesterday')).toBeInTheDocument();

    expect(screen.getByRole('heading', { name: 'Start a new project' })).toBeInTheDocument();
  });

  it('shows an error with a working retry', async () => {
    let attempts = 0;
    server.use(
      ...signedInHandlers(),
      http.get(`${API}/projects`, () => {
        attempts += 1;
        return attempts === 1
          ? fail(500, 'INTERNAL_ERROR', 'Something went wrong.')
          : ok(page([makeProject()]));
      }),
    );
    renderApp('/projects');
    const user = userEvent.setup();

    expect(await screen.findByText(/We could not load your projects/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('heading', { name: 'Customer 360 demo' })).toBeInTheDocument();
  });

  it.each<Role>(['viewer', 'data_steward'])('hides "New project" from a %s', async (role) => {
    listReturns([makeProject()], role);
    renderApp('/projects');

    await screen.findByRole('heading', { name: 'Customer 360 demo' });
    expect(screen.queryByRole('button', { name: 'New project' })).not.toBeInTheDocument();
    expect(screen.queryByText('Start a new project')).not.toBeInTheDocument();
  });

  it('disables project pages in the sidebar until a project is open', async () => {
    listReturns([]);
    renderApp('/projects');

    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Projects' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Mapping' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});

describe('new project dialog', () => {
  async function openDialog() {
    const user = userEvent.setup();
    const title = await screen.findByRole('heading', { level: 1, name: 'Projects' });
    const header = within(element(title.closest('header')));
    await user.click(header.getByRole('button', { name: 'New project' }));
    return { user, dialog: await screen.findByRole('dialog', { name: 'New project' }) };
  }

  it('validates the name before calling the api', async () => {
    listReturns([]);
    renderApp('/projects');
    const { user, dialog } = await openDialog();

    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));
    expect(await within(dialog).findByText('Enter a project name.')).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText('Name'), 'x'.repeat(81));
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));
    expect(await within(dialog).findByText('Use 80 characters or fewer.')).toBeInTheDocument();
  });

  it('creates the project, confirms it and opens its sources step', async () => {
    const created = makeProject({
      id: '64b0000000000000000000b7',
      name: 'Pharma product master',
      currentStep: 'sources',
    });
    let body: unknown = null;
    listReturns([]);
    server.use(
      http.post(`${API}/projects`, async ({ request }) => {
        body = await request.json();
        return ok({ project: created }, 201);
      }),
      http.get(`${API}/projects/:id`, () => ok({ project: created })),
      http.get(`${API}/projects/:id/sources`, () => ok({ items: [] })),
      http.get(`${API}/projects/:id/jobs`, () => ok({ items: [] })),
    );
    const { router } = renderApp('/projects');
    const { user, dialog } = await openDialog();

    await user.type(within(dialog).getByLabelText('Name'), 'Pharma product master');
    await user.type(within(dialog).getByLabelText(/Description/), 'SKU clean-up');
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/projects/64b0000000000000000000b7/sources');
    });
    expect(body).toEqual({ name: 'Pharma product master', description: 'SKU clean-up' });
    expect(await screen.findByText('Project "Pharma product master" created')).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: 'Add your source files' }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'No files yet' })).toBeInTheDocument();
  });

  it('shows server validation errors next to the field', async () => {
    listReturns([]);
    server.use(
      http.post(`${API}/projects`, () =>
        fail(400, 'VALIDATION_ERROR', 'Some fields are invalid.', [
          { field: 'body.name', message: 'is required' },
        ]),
      ),
    );
    renderApp('/projects');
    const { user, dialog } = await openDialog();

    await user.type(within(dialog).getByLabelText('Name'), 'A name');
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));

    expect(await within(dialog).findByText('Name is required.')).toBeInTheDocument();
  });
});

describe('project pages', () => {
  it('render the shell, breadcrumb, stepper and the step page', async () => {
    const project = makeProject({ currentStep: 'mapping' });
    server.use(
      ...signedInHandlers(),
      http.get(`${API}/projects/:id`, () => ok({ project })),
      http.get(`${API}/projects/:id/sql/versions`, () => ok({ items: [] })),
      http.get(`${API}/projects/:id/exports`, () => ok({ items: [] })),
    );
    renderApp(`/projects/${project.id}/pipeline`);

    expect(
      await screen.findByRole('heading', { name: 'Build the clean dataset' }),
    ).toBeInTheDocument();
    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(breadcrumb).toHaveTextContent('Projects/Customer 360 demo/Pipeline');
    expect(screen.getByRole('list', { name: 'Project steps' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'No SQL version yet' })).toBeInTheDocument();
    expect(document.title).toBe('Pipeline · Customer 360 demo · DataBridge AI');

    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Pipeline' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Projects' })).not.toHaveAttribute('aria-current');
  });

  it('dashboard and assistant have no stepper', async () => {
    const project = makeProject();
    server.use(
      ...signedInHandlers(),
      http.get(`${API}/projects/:id`, () => ok({ project })),
    );
    renderApp(`/projects/${project.id}/assistant`);

    expect(await screen.findByText('Coming in milestone M6')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Project steps' })).not.toBeInTheDocument();
  });

  it('explain a project that does not exist', async () => {
    server.use(
      ...signedInHandlers(),
      http.get(`${API}/projects/:id`, () => fail(404, 'NOT_FOUND', 'Project not found.')),
    );
    renderApp('/projects/64b0000000000000000000ff/sources');

    expect(await screen.findByRole('heading', { name: 'Project not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to projects' })).toHaveAttribute(
      'href',
      '/projects',
    );
  });
});
