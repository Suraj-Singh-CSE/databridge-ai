import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { buildTestApp, TEST_BOOTSTRAP_ADMIN_EMAIL } from './support/build-app.js';

const PASSWORD = 'correct horse battery';
const INVITE = 'demo-invite-2026';

function register(app: ReturnType<typeof buildTestApp>, body: Record<string, unknown>) {
  return request(app)
    .post('/api/v1/auth/register')
    .send({ name: 'Someone', password: PASSWORD, ...body });
}

describe('GET /api/v1/auth/config', () => {
  it.each(['open', 'invite', 'closed'] as const)(
    'reports registrationMode=%s without a session, and nothing secret',
    async (mode) => {
      const env = { REGISTRATION_MODE: mode, REGISTRATION_INVITE_CODES: INVITE };
      const res = await request(buildTestApp({ env })).get('/api/v1/auth/config');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: { registrationMode: mode }, error: null });
      expect(JSON.stringify(res.body)).not.toContain(INVITE);
    },
  );
});

describe('POST /api/v1/auth/register by REGISTRATION_MODE', () => {
  it('invite: 201 with the right code, 403 INVITE_CODE_INVALID without or with a wrong one', async () => {
    const app = buildTestApp({
      env: { REGISTRATION_MODE: 'invite', REGISTRATION_INVITE_CODES: `other-code-1,${INVITE}` },
    });

    const missing = await register(app, { email: 'a@example.com' });
    expect(missing.status).toBe(403);
    expect(missing.body).toEqual({
      data: null,
      error: {
        code: 'INVITE_CODE_INVALID',
        message: 'That invite code is not valid. Check it and try again.',
        details: null,
      },
    });
    const wrong = await register(app, { email: 'a@example.com', inviteCode: 'guess-1234' });
    expect(wrong.body.error.code).toBe('INVITE_CODE_INVALID');

    const ok = await register(app, { email: 'a@example.com', inviteCode: ` ${INVITE} ` });
    expect(ok.status).toBe(201);
    expect(ok.body.data.user.role).toBe('data_engineer');
  });

  it('invite: the bootstrap admin also needs a code', async () => {
    const app = buildTestApp({
      env: { REGISTRATION_MODE: 'invite', REGISTRATION_INVITE_CODES: INVITE },
    });

    expect((await register(app, { email: TEST_BOOTSTRAP_ADMIN_EMAIL })).status).toBe(403);
    const ok = await register(app, { email: TEST_BOOTSTRAP_ADMIN_EMAIL, inviteCode: INVITE });
    expect(ok.body.data.user.role).toBe('admin');
  });

  it('closed: 403 REGISTRATION_CLOSED, sign-in still works for existing accounts', async () => {
    const app = buildTestApp({ env: { REGISTRATION_MODE: 'closed' } });
    const res = await register(app, { email: 'a@example.com', inviteCode: INVITE });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('REGISTRATION_CLOSED');
    expect(res.headers['set-cookie']).toBeUndefined();
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'a@example.com', password: PASSWORD });
    expect(login.status).toBe(401);
  });

  it('open: no code needed; an over-long code is a validation error', async () => {
    const app = buildTestApp();

    expect((await register(app, { email: 'a@example.com' })).status).toBe(201);
    const long = await register(app, { email: 'b@example.com', inviteCode: 'x'.repeat(201) });
    expect(long.status).toBe(400);
    expect(long.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('makes nobody admin when BOOTSTRAP_ADMIN_EMAIL is unset', async () => {
    const app = buildTestApp({ env: { BOOTSTRAP_ADMIN_EMAIL: '' } });
    const first = await register(app, { email: TEST_BOOTSTRAP_ADMIN_EMAIL });

    expect(first.body.data.user.role).toBe('data_engineer');
  });
});
