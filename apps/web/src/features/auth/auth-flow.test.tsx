import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { safeNextPath } from '@/features/auth/next-path';
import { receiveAuthMessage } from '@/lib/session';
import {
  API,
  fail,
  makeProject,
  makeSession,
  ok,
  page,
  signedInHandlers,
  signedOutHandlers,
} from '@/test/fixtures';
import { renderApp } from '@/test/render-app';
import { server } from '@/test/server';

const project = makeProject();

function projectHandlers() {
  return [
    http.get(`${API}/projects`, () => ok(page([project]))),
    http.get(`${API}/projects/:id`, () => ok({ project })),
  ];
}

async function fillSignIn(email: string, password: string) {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Email'), email);
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  return user;
}

describe('session restore on load', () => {
  it('restores the session from the refresh cookie and shows the projects page', async () => {
    server.use(...signedInHandlers(), ...projectHandlers());
    renderApp('/projects');

    expect(await screen.findByRole('heading', { level: 1, name: 'Projects' })).toBeInTheDocument();
    expect(screen.getByText('steward@demo.dev')).toBeInTheDocument();
  });

  it('sends signed-out visitors to sign in, remembering where they were going', async () => {
    server.use(...signedOutHandlers());
    const { router } = renderApp('/projects/abc/mapping');

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/sign-in');
    expect(router.state.location.search).toBe(
      `?next=${encodeURIComponent('/projects/abc/mapping')}`,
    );
    expect(document.title).toBe('Sign in · DataBridge AI');
  });

  it('sends signed-in users away from the sign-in page', async () => {
    server.use(...signedInHandlers(), ...projectHandlers());
    const { router } = renderApp('/sign-in');

    expect(await screen.findByRole('heading', { level: 1, name: 'Projects' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/projects');
  });
});

describe('sign in', () => {
  it('signs in and continues to the page from `next`', async () => {
    let body: unknown = null;
    server.use(
      ...signedOutHandlers(),
      ...projectHandlers(),
      http.post(`${API}/auth/login`, async ({ request }) => {
        body = await request.json();
        return ok(makeSession());
      }),
    );
    const { router } = renderApp(
      `/sign-in?next=${encodeURIComponent(`/projects/${project.id}/mapping`)}`,
    );

    await fillSignIn('steward@demo.dev', 'correct horse battery');

    expect(await screen.findByRole('heading', { name: 'Columns that match' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/projects/${project.id}/mapping`);
    expect(body).toEqual({ email: 'steward@demo.dev', password: 'correct horse battery' });
  });

  it.each([
    [401, 'UNAUTHORIZED', 'Email or password is incorrect.'],
    [429, 'RATE_LIMITED', 'Too many attempts. Try again in a few minutes.'],
  ])('shows a calm message for a %i answer', async (status, code, message) => {
    server.use(
      ...signedOutHandlers(),
      http.post(`${API}/auth/login`, () => fail(status, code, 'server text')),
    );
    renderApp('/sign-in');

    await fillSignIn('steward@demo.dev', 'wrong password');

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('validates fields before calling the api', async () => {
    let called = false;
    server.use(
      ...signedOutHandlers(),
      http.post(`${API}/auth/login`, () => {
        called = true;
        return ok(makeSession());
      }),
    );
    renderApp('/sign-in');
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText('Email'), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Enter a valid email.')).toBeInTheDocument();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(called).toBe(false);
  });

  it('autofocuses the email field and sets autocomplete hints', async () => {
    server.use(...signedOutHandlers());
    renderApp('/sign-in');

    const email = await screen.findByLabelText('Email');
    expect(email).toHaveFocus();
    expect(email).toHaveAttribute('autocomplete', 'email');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
  });
});

describe('create account', () => {
  async function fillCreateAccount(password = 'long-enough-password') {
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Name'), 'Asha Rao');
    await user.type(screen.getByLabelText('Email'), 'asha@example.com');
    await user.type(screen.getByLabelText('Password'), password);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
  }

  it('creates the account and lands on projects', async () => {
    server.use(
      ...signedOutHandlers(),
      ...projectHandlers(),
      http.post(`${API}/auth/register`, () => ok(makeSession('admin'), 201)),
    );
    const { router } = renderApp('/create-account');

    await fillCreateAccount();

    expect(await screen.findByRole('heading', { level: 1, name: 'Projects' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/projects');
  });

  it('requires 10 or more password characters', async () => {
    server.use(...signedOutHandlers());
    renderApp('/create-account');

    await fillCreateAccount('short');

    expect(await screen.findByText('Use at least 10 characters.')).toBeInTheDocument();
  });

  it('explains when the email is already registered', async () => {
    server.use(
      ...signedOutHandlers(),
      http.post(`${API}/auth/register`, () => fail(409, 'CONFLICT', 'Email already registered.')),
    );
    renderApp('/create-account');

    await fillCreateAccount();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'An account with this email already exists.',
    );
  });
});

describe('sign out', () => {
  it('signs out from the user menu and returns to sign in', async () => {
    let loggedOut = false;
    server.use(
      ...signedInHandlers(),
      ...projectHandlers(),
      http.post(`${API}/auth/logout`, () => {
        loggedOut = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { router } = renderApp('/projects');
    const user = userEvent.setup();

    const trigger = await screen.findByRole('button', { name: 'Account menu for Data steward' });
    trigger.focus();
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(loggedOut).toBe(true);
    expect(router.state.location.pathname).toBe('/sign-in');
  });

  it('follows a sign-out made in another tab', async () => {
    server.use(...signedInHandlers(), ...projectHandlers());
    renderApp('/projects');
    await screen.findByRole('heading', { level: 1, name: 'Projects' });

    act(() => {
      receiveAuthMessage({ type: 'signed-out', at: Date.now() });
    });

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });
});

describe('safeNextPath', () => {
  it.each([
    ['/projects/1/mapping', '/projects/1/mapping'],
    [null, '/projects'],
    ['https://evil.example', '/projects'],
    ['//evil.example', '/projects'],
    ['/\\evil.example', '/projects'],
  ])('%s -> %s', (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });
});

describe('not found', () => {
  it('shows a 404 page for unknown routes', async () => {
    server.use(...signedOutHandlers());
    renderApp('/no/such/page');

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('main')).getByRole('link', { name: 'Go to projects' }),
    ).toBeInTheDocument();
  });
});

describe('session loading state', () => {
  it('keeps the loading state accessible while the session is restored', async () => {
    server.use(
      http.post(`${API}/auth/refresh`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return fail(401, 'UNAUTHORIZED', 'No session.');
      }),
    );
    renderApp('/projects');

    expect(screen.getByRole('status')).toHaveTextContent('Loading your session');
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    });
  });
});
