import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Repositories } from '../../src/repositories.js';

import { buildTestApp, fastPasswords } from './build-app.js';

export interface Harness {
  /** Fresh, empty repositories for one test. */
  setup(): Promise<Repositories>;
}

interface Session {
  id: string;
  token: string;
  cookie: string;
}

const PASSWORD = 'correct horse battery';

function cookieFrom(res: request.Response): string {
  const header = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = header?.find((c) => c.startsWith('db_rt='));
  if (!cookie) throw new Error('no db_rt cookie set');
  return cookie;
}

/** "db_rt=<value>" part only, as a browser would send it back. */
function cookiePair(setCookie: string): string {
  return setCookie.split(';')[0] ?? '';
}

const bearer = (s: Session) => ({ Authorization: `Bearer ${s.token}` });

/**
 * The full HTTP contract of the API, written once and run against both the in-memory
 * repositories (always) and real MongoDB (CI, or locally when Mongo is reachable).
 */
export function defineApiSuite(label: string, harness: Harness): void {
  describe(`API (${label})`, () => {
    let app: Express;
    let repos: Repositories;

    beforeEach(async () => {
      repos = await harness.setup();
      app = buildTestApp({ repos });
    });

    async function register(email: string, name = 'Test User'): Promise<Session> {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ email, name, password: PASSWORD })
        .expect(201);
      const body = res.body as { data: { user: { id: string }; accessToken: string } };
      return { id: body.data.user.id, token: body.data.accessToken, cookie: cookieFrom(res) };
    }

    /** A user created directly with a global role registration never assigns. */
    async function userWithRole(email: string, role: 'viewer' | 'data_steward'): Promise<Session> {
      await repos.users.create({
        email,
        name: role,
        role,
        passwordHash: await fastPasswords.hash(PASSWORD),
      });
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email, password: PASSWORD })
        .expect(200);
      const body = res.body as { data: { user: { id: string }; accessToken: string } };
      return { id: body.data.user.id, token: body.data.accessToken, cookie: cookieFrom(res) };
    }

    async function createProject(owner: Session, name = 'Customer 360'): Promise<string> {
      const res = await request(app)
        .post('/api/v1/projects')
        .set(bearer(owner))
        .send({ name, description: 'Merge CRM and billing' })
        .expect(201);
      return (res.body as { data: { project: { id: string } } }).data.project.id;
    }

    describe('POST /auth/register', () => {
      it('makes only BOOTSTRAP_ADMIN_EMAIL admin, not the first registrant', async () => {
        const first = await request(app)
          .post('/api/v1/auth/register')
          .send({ email: 'first@example.com', name: 'First', password: PASSWORD });
        const boss = await request(app)
          .post('/api/v1/auth/register')
          .send({ email: '  First-Admin@Example.com ', name: 'Boss', password: PASSWORD });
        const third = await request(app)
          .post('/api/v1/auth/register')
          .send({ email: 'third@example.com', name: 'Third', password: PASSWORD });

        expect(first.status).toBe(201);
        expect(first.body.data.user.role).toBe('data_engineer');
        expect(boss.body.data.user).toMatchObject({
          email: 'first-admin@example.com',
          role: 'admin',
        });
        expect(third.body.data.user.role).toBe('data_engineer');
        expect(typeof first.body.data.accessToken).toBe('string');
        expect(JSON.stringify(first.body)).not.toMatch(/passwordHash|\$2[aby]\$/);
      });

      it('sets a hardened refresh cookie', async () => {
        const res = await request(app)
          .post('/api/v1/auth/register')
          .send({ email: 'a@example.com', name: 'A', password: PASSWORD });
        const cookie = cookieFrom(res);

        expect(cookie).toMatch(/HttpOnly/);
        expect(cookie).toMatch(/SameSite=Strict/);
        expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
        expect(cookie).toMatch(/Max-Age=604800/);
        // Secure is only set in production (tests run over plain HTTP).
        expect(cookie).not.toMatch(/Secure/);
      });

      it('rejects a duplicate email (any case) with 409', async () => {
        await register('dup@example.com');
        const res = await request(app)
          .post('/api/v1/auth/register')
          .send({ email: 'DUP@example.com', name: 'Again', password: PASSWORD });

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('CONFLICT');
      });

      it('returns field-level validation errors', async () => {
        const res = await request(app)
          .post('/api/v1/auth/register')
          .send({ email: 'not-an-email', name: '', password: 'short', extra: true });

        expect(res.status).toBe(400);
        expect(res.body.data).toBeNull();
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        const fields = (res.body.error.details as { field: string }[]).map((d) => d.field);
        expect(fields).toEqual(
          expect.arrayContaining(['body.email', 'body.name', 'body.password', 'body']),
        );
      });

      it('enforces the 10-128 character password policy', async () => {
        const tooLong = await request(app)
          .post('/api/v1/auth/register')
          .send({ email: 'long@example.com', name: 'L', password: 'x'.repeat(129) });
        const maxLength = await request(app)
          .post('/api/v1/auth/register')
          .send({ email: 'max@example.com', name: 'M', password: 'x'.repeat(128) });

        expect(tooLong.status).toBe(400);
        expect(maxLength.status).toBe(201);
      });
    });

    describe('POST /auth/login', () => {
      it('returns the user, an access token and a refresh cookie', async () => {
        await register('login@example.com');
        const res = await request(app)
          .post('/api/v1/auth/login')
          .send({ email: 'LOGIN@example.com', password: PASSWORD });

        expect(res.status).toBe(200);
        expect(res.body.data.user.email).toBe('login@example.com');
        expect(res.body.data.accessToken).toEqual(expect.any(String));
        expect(cookieFrom(res)).toMatch(/^db_rt=/);
      });

      it('gives the same 401 for a wrong password and an unknown email', async () => {
        await register('known@example.com');
        const wrongPassword = await request(app)
          .post('/api/v1/auth/login')
          .send({ email: 'known@example.com', password: 'wrong password!' });
        const unknownEmail = await request(app)
          .post('/api/v1/auth/login')
          .send({ email: 'nobody@example.com', password: PASSWORD });

        expect(wrongPassword.status).toBe(401);
        expect(unknownEmail.status).toBe(401);
        expect(wrongPassword.body).toEqual(unknownEmail.body);
        expect(wrongPassword.body.error.code).toBe('UNAUTHORIZED');
      });

      it('validates input', async () => {
        const res = await request(app).post('/api/v1/auth/login').send({ email: 'x' });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      });
    });

    describe('POST /auth/refresh', () => {
      it('rotates the refresh token and returns a new access token', async () => {
        const session = await register('r@example.com');
        const res = await request(app)
          .post('/api/v1/auth/refresh')
          .set('Cookie', cookiePair(session.cookie));

        expect(res.status).toBe(200);
        expect(res.body.data.accessToken).toEqual(expect.any(String));
        expect(res.body.data.user.id).toBe(session.id);
        expect(cookiePair(cookieFrom(res))).not.toBe(cookiePair(session.cookie));
      });

      it('detects reuse of a rotated token and revokes the whole family', async () => {
        const session = await register('theft@example.com');
        const stolen = cookiePair(session.cookie);
        const rotated = await request(app).post('/api/v1/auth/refresh').set('Cookie', stolen);
        const current = cookiePair(cookieFrom(rotated));

        const replay = await request(app).post('/api/v1/auth/refresh').set('Cookie', stolen);
        expect(replay.status).toBe(401);
        expect(replay.headers['set-cookie']?.[0]).toMatch(/^db_rt=;/);

        // The legitimate holder's newer token is now revoked too: both must sign in again.
        const afterTheft = await request(app).post('/api/v1/auth/refresh').set('Cookie', current);
        expect(afterTheft.status).toBe(401);
      });

      it('stores refresh tokens hashed, linked by family and replacement', async () => {
        const session = await register('hash@example.com');
        const raw = cookiePair(session.cookie).slice('db_rt='.length);
        await request(app)
          .post('/api/v1/auth/refresh')
          .set('Cookie', cookiePair(session.cookie))
          .expect(200);

        expect(await repos.refreshTokens.findByHash(raw)).toBeNull();
        const { createTokenService } = await import('../../src/modules/auth/tokens.js');
        const { loadConfig } = await import('../../src/config.js');
        const hash = createTokenService(loadConfig({ NODE_ENV: 'test' })).hashRefreshToken(raw);
        const old = await repos.refreshTokens.findByHash(hash);
        expect(old?.revokedAt).toBeInstanceOf(Date);
        expect(old?.replacedBy).toMatch(/^[a-f\d]{24}$/);
      });

      it('rejects a missing or unknown cookie', async () => {
        const missing = await request(app).post('/api/v1/auth/refresh');
        const unknown = await request(app)
          .post('/api/v1/auth/refresh')
          .set('Cookie', 'db_rt=not-a-real-token');

        expect(missing.status).toBe(401);
        expect(unknown.status).toBe(401);
      });
    });

    describe('POST /auth/logout', () => {
      it('revokes the refresh token and clears the cookie', async () => {
        const session = await register('out@example.com');
        const res = await request(app)
          .post('/api/v1/auth/logout')
          .set('Cookie', cookiePair(session.cookie));

        expect(res.status).toBe(204);
        expect(res.headers['set-cookie']?.[0]).toMatch(/^db_rt=;.*Path=\/api\/v1\/auth/);
        const refresh = await request(app)
          .post('/api/v1/auth/refresh')
          .set('Cookie', cookiePair(session.cookie));
        expect(refresh.status).toBe(401);
      });

      it('succeeds without a cookie', async () => {
        await request(app).post('/api/v1/auth/logout').expect(204);
      });
    });

    describe('GET /auth/me', () => {
      it('returns the current user', async () => {
        const session = await register('me@example.com', 'Me');
        const res = await request(app).get('/api/v1/auth/me').set(bearer(session));

        expect(res.status).toBe(200);
        expect(res.body.data.user).toMatchObject({ id: session.id, name: 'Me' });
        expect(res.body.data.user.passwordHash).toBeUndefined();
      });

      it('requires a valid bearer token', async () => {
        const none = await request(app).get('/api/v1/auth/me');
        const garbage = await request(app)
          .get('/api/v1/auth/me')
          .set('Authorization', 'Bearer abc.def.ghi');

        expect(none.status).toBe(401);
        expect(garbage.status).toBe(401);
        expect(none.body.error.code).toBe('UNAUTHORIZED');
      });
    });

    describe('projects', () => {
      let admin: Session;
      let alice: Session;
      let bob: Session;

      beforeEach(async () => {
        admin = await register('first-admin@example.com', 'Admin');
        alice = await register('alice@example.com', 'Alice');
        bob = await register('bob@example.com', 'Bob');
      });

      describe('POST /projects', () => {
        it('creates a project owned by the caller, who is also a data_engineer member', async () => {
          const res = await request(app)
            .post('/api/v1/projects')
            .set(bearer(alice))
            .send({ name: '  Customer 360 ' });

          expect(res.status).toBe(201);
          expect(res.body.data.project).toMatchObject({
            name: 'Customer 360',
            description: '',
            ownerId: alice.id,
            members: [{ userId: alice.id, role: 'data_engineer' }],
            status: 'active',
            currentStep: 'sources',
          });
        });

        it('is limited to admin and data_engineer roles', async () => {
          const viewer = await userWithRole('viewer@example.com', 'viewer');
          const steward = await userWithRole('steward@example.com', 'data_steward');

          for (const session of [viewer, steward]) {
            const res = await request(app)
              .post('/api/v1/projects')
              .set(bearer(session))
              .send({ name: 'Nope' });
            expect(res.status).toBe(403);
            expect(res.body.error.code).toBe('FORBIDDEN');
          }
          await request(app)
            .post('/api/v1/projects')
            .set(bearer(admin))
            .send({ name: 'Admin project' })
            .expect(201);
        });

        it('validates the body', async () => {
          const res = await request(app)
            .post('/api/v1/projects')
            .set(bearer(alice))
            .send({ name: 'x'.repeat(81), description: 'd'.repeat(501), ownerId: bob.id });

          expect(res.status).toBe(400);
          const fields = (res.body.error.details as { field: string }[]).map((d) => d.field);
          expect(fields).toEqual(expect.arrayContaining(['body.name', 'body.description']));
        });

        it('requires authentication', async () => {
          await request(app).post('/api/v1/projects').send({ name: 'x' }).expect(401);
        });
      });

      describe('GET /projects', () => {
        it('lists only projects the user owns or belongs to; admins see all', async () => {
          await createProject(alice, 'A1');
          await createProject(alice, 'A2');
          await createProject(bob, 'B1');

          const forAlice = await request(app).get('/api/v1/projects').set(bearer(alice));
          const forAdmin = await request(app).get('/api/v1/projects').set(bearer(admin));

          expect(forAlice.status).toBe(200);
          expect(forAlice.body).toMatchObject({
            data: { page: 1, limit: 20, total: 2 },
            error: null,
          });
          const names = (forAlice.body.data.items as { name: string }[]).map((p) => p.name);
          expect(names.sort()).toEqual(['A1', 'A2']);
          expect(forAdmin.body.data.total).toBe(3);
        });

        it('includes projects where the user was added as a member', async () => {
          const id = await createProject(alice);
          await request(app)
            .post(`/api/v1/projects/${id}/members`)
            .set(bearer(alice))
            .send({ email: 'bob@example.com', role: 'viewer' })
            .expect(201);

          const res = await request(app).get('/api/v1/projects').set(bearer(bob));
          expect(res.body.data.items.map((p: { id: string }) => p.id)).toEqual([id]);
        });

        it('paginates', async () => {
          for (const name of ['P1', 'P2', 'P3']) await createProject(alice, name);

          const res = await request(app).get('/api/v1/projects?page=2&limit=2').set(bearer(alice));

          expect(res.body.data).toMatchObject({ page: 2, limit: 2, total: 3 });
          expect(res.body.data.items).toHaveLength(1);
        });

        it('rejects invalid pagination', async () => {
          const res = await request(app).get('/api/v1/projects?limit=101').set(bearer(alice));

          expect(res.status).toBe(400);
          expect(res.body.error.details[0].field).toBe('query.limit');
        });

        it('requires authentication', async () => {
          await request(app).get('/api/v1/projects').expect(401);
        });
      });

      describe('GET /projects/:id', () => {
        it('returns the project to its owner and to admins', async () => {
          const id = await createProject(alice);

          for (const session of [alice, admin]) {
            const res = await request(app).get(`/api/v1/projects/${id}`).set(bearer(session));
            expect(res.status).toBe(200);
            expect(res.body.data.project.id).toBe(id);
          }
        });

        it('returns 404, not 403, to non-members', async () => {
          const id = await createProject(alice);
          const res = await request(app).get(`/api/v1/projects/${id}`).set(bearer(bob));
          const missing = await request(app)
            .get('/api/v1/projects/0123456789abcdef01234567')
            .set(bearer(bob));

          expect(res.status).toBe(404);
          expect(res.body).toEqual(missing.body);
        });

        it('rejects an invalid id with 400', async () => {
          const res = await request(app).get('/api/v1/projects/not-an-id').set(bearer(alice));

          expect(res.status).toBe(400);
          expect(res.body.error.details[0].field).toBe('params.id');
        });

        it('requires authentication', async () => {
          const id = await createProject(alice);
          await request(app).get(`/api/v1/projects/${id}`).expect(401);
        });
      });

      describe('PATCH /projects/:id', () => {
        it('lets the owner and data_engineer members update the project', async () => {
          const id = await createProject(alice);
          await request(app)
            .post(`/api/v1/projects/${id}/members`)
            .set(bearer(alice))
            .send({ email: 'bob@example.com', role: 'data_engineer' })
            .expect(201);

          const byOwner = await request(app)
            .patch(`/api/v1/projects/${id}`)
            .set(bearer(alice))
            .send({ name: 'Renamed', currentStep: 'mapping' });
          const byMember = await request(app)
            .patch(`/api/v1/projects/${id}`)
            .set(bearer(bob))
            .send({ status: 'archived' });

          expect(byOwner.status).toBe(200);
          expect(byOwner.body.data.project).toMatchObject({
            name: 'Renamed',
            currentStep: 'mapping',
          });
          expect(byMember.body.data.project).toMatchObject({
            name: 'Renamed',
            status: 'archived',
          });
        });

        it('forbids members below data_engineer and hides the project from others', async () => {
          const id = await createProject(alice);
          await request(app)
            .post(`/api/v1/projects/${id}/members`)
            .set(bearer(alice))
            .send({ email: 'bob@example.com', role: 'viewer' })
            .expect(201);
          const outsider = await register('eve@example.com');

          const byViewer = await request(app)
            .patch(`/api/v1/projects/${id}`)
            .set(bearer(bob))
            .send({ name: 'x' });
          const byOutsider = await request(app)
            .patch(`/api/v1/projects/${id}`)
            .set(bearer(outsider))
            .send({ name: 'x' });

          expect(byViewer.status).toBe(403);
          expect(byOutsider.status).toBe(404);
        });

        it('validates the body', async () => {
          const id = await createProject(alice);
          const empty = await request(app)
            .patch(`/api/v1/projects/${id}`)
            .set(bearer(alice))
            .send({});
          const badStep = await request(app)
            .patch(`/api/v1/projects/${id}`)
            .set(bearer(alice))
            .send({ currentStep: 'deploy', ownerId: bob.id });

          expect(empty.status).toBe(400);
          expect(badStep.status).toBe(400);
        });

        it('requires authentication', async () => {
          const id = await createProject(alice);
          await request(app).patch(`/api/v1/projects/${id}`).send({ name: 'x' }).expect(401);
        });
      });

      describe('DELETE /projects/:id', () => {
        it('lets the owner delete the project', async () => {
          const id = await createProject(alice);

          await request(app).delete(`/api/v1/projects/${id}`).set(bearer(alice)).expect(204);
          await request(app).get(`/api/v1/projects/${id}`).set(bearer(alice)).expect(404);
        });

        it('lets an admin delete any project', async () => {
          const id = await createProject(alice);
          await request(app).delete(`/api/v1/projects/${id}`).set(bearer(admin)).expect(204);
        });

        it('forbids non-owner members and hides the project from outsiders', async () => {
          const id = await createProject(alice);
          await request(app)
            .post(`/api/v1/projects/${id}/members`)
            .set(bearer(alice))
            .send({ email: 'bob@example.com', role: 'data_engineer' })
            .expect(201);
          const outsider = await register('eve@example.com');

          await request(app).delete(`/api/v1/projects/${id}`).set(bearer(bob)).expect(403);
          await request(app).delete(`/api/v1/projects/${id}`).set(bearer(outsider)).expect(404);
        });

        it('validates the id and requires authentication', async () => {
          await request(app).delete('/api/v1/projects/123').set(bearer(alice)).expect(400);
          const id = await createProject(alice);
          await request(app).delete(`/api/v1/projects/${id}`).expect(401);
        });
      });

      describe('project members', () => {
        it('lets the owner add and remove members', async () => {
          const id = await createProject(alice);

          const added = await request(app)
            .post(`/api/v1/projects/${id}/members`)
            .set(bearer(alice))
            .send({ email: 'BOB@example.com', role: 'data_steward' });
          expect(added.status).toBe(201);
          expect(added.body.data.project.members).toContainEqual({
            userId: bob.id,
            role: 'data_steward',
          });
          await request(app).get(`/api/v1/projects/${id}`).set(bearer(bob)).expect(200);

          const removed = await request(app)
            .delete(`/api/v1/projects/${id}/members/${bob.id}`)
            .set(bearer(alice));
          expect(removed.status).toBe(200);
          expect(removed.body.data.project.members).toEqual([
            { userId: alice.id, role: 'data_engineer' },
          ]);
          await request(app).get(`/api/v1/projects/${id}`).set(bearer(bob)).expect(404);
        });

        it('lets an admin manage members', async () => {
          const id = await createProject(alice);
          await request(app)
            .post(`/api/v1/projects/${id}/members`)
            .set(bearer(admin))
            .send({ email: 'bob@example.com', role: 'viewer' })
            .expect(201);
        });

        it('rejects unknown users, duplicates and removing the owner', async () => {
          const id = await createProject(alice);
          const add = (email: string) =>
            request(app)
              .post(`/api/v1/projects/${id}/members`)
              .set(bearer(alice))
              .send({ email, role: 'viewer' });

          expect((await add('ghost@example.com')).status).toBe(404);
          expect((await add('bob@example.com')).status).toBe(201);
          expect((await add('bob@example.com')).status).toBe(409);
          expect((await add('alice@example.com')).status).toBe(409);

          const removeOwner = await request(app)
            .delete(`/api/v1/projects/${id}/members/${alice.id}`)
            .set(bearer(alice));
          expect(removeOwner.status).toBe(409);

          const removeStranger = await request(app)
            .delete(`/api/v1/projects/${id}/members/${admin.id}`)
            .set(bearer(alice));
          expect(removeStranger.status).toBe(404);
        });

        it('forbids non-owner members and hides the project from outsiders', async () => {
          const id = await createProject(alice);
          await request(app)
            .post(`/api/v1/projects/${id}/members`)
            .set(bearer(alice))
            .send({ email: 'bob@example.com', role: 'data_engineer' })
            .expect(201);
          const outsider = await register('eve@example.com');

          await request(app)
            .post(`/api/v1/projects/${id}/members`)
            .set(bearer(bob))
            .send({ email: 'eve@example.com', role: 'viewer' })
            .expect(403);
          await request(app)
            .delete(`/api/v1/projects/${id}/members/${alice.id}`)
            .set(bearer(bob))
            .expect(403);
          await request(app)
            .post(`/api/v1/projects/${id}/members`)
            .set(bearer(outsider))
            .send({ email: 'eve@example.com', role: 'viewer' })
            .expect(404);
        });

        it('validates input and requires authentication', async () => {
          const id = await createProject(alice);
          await request(app)
            .post(`/api/v1/projects/${id}/members`)
            .set(bearer(alice))
            .send({ email: 'bob@example.com', role: 'admin' })
            .expect(400);
          await request(app)
            .delete(`/api/v1/projects/${id}/members/nope`)
            .set(bearer(alice))
            .expect(400);
          await request(app)
            .post(`/api/v1/projects/${id}/members`)
            .send({ email: 'bob@example.com', role: 'viewer' })
            .expect(401);
          await request(app).delete(`/api/v1/projects/${id}/members/${bob.id}`).expect(401);
        });
      });

      describe('GET /projects/:id/people', () => {
        it('labels current members by name, owner first, without emails', async () => {
          const id = await createProject(alice);
          await userWithRole('carol@example.com', 'data_steward');
          for (const email of ['bob@example.com', 'carol@example.com']) {
            await request(app)
              .post(`/api/v1/projects/${id}/members`)
              .set(bearer(alice))
              .send({ email, role: 'data_steward' })
              .expect(201);
          }

          const res = await request(app).get(`/api/v1/projects/${id}/people`).set(bearer(bob));

          expect(res.status).toBe(200);
          const people = (res.body as { data: { people: { label: string }[] } }).data.people;
          expect(people).toEqual([
            { userId: alice.id, label: 'Alice', role: 'data_engineer', owner: true },
            { userId: bob.id, label: 'Bob', role: 'data_steward', owner: false },
            {
              userId: expect.any(String) as string,
              label: 'data_steward',
              role: 'data_steward',
              owner: false,
            },
          ]);
          expect(JSON.stringify(res.body)).not.toMatch(/@example\.com/);
        });

        it('drops people once they leave the project', async () => {
          const id = await createProject(alice);
          await request(app)
            .post(`/api/v1/projects/${id}/members`)
            .set(bearer(alice))
            .send({ email: 'bob@example.com', role: 'viewer' })
            .expect(201);
          await request(app)
            .delete(`/api/v1/projects/${id}/members/${bob.id}`)
            .set(bearer(alice))
            .expect(200);

          const res = await request(app).get(`/api/v1/projects/${id}/people`).set(bearer(alice));
          expect(res.body.data.people).toEqual([
            { userId: alice.id, label: 'Alice', role: 'data_engineer', owner: true },
          ]);
        });

        it('validates the id, requires authentication and hides the project from outsiders', async () => {
          const id = await createProject(alice);
          await request(app).get('/api/v1/projects/nope/people').set(bearer(alice)).expect(400);
          await request(app).get(`/api/v1/projects/${id}/people`).expect(401);
          await request(app).get(`/api/v1/projects/${id}/people`).set(bearer(bob)).expect(404);
        });
      });

      describe('GET /projects/:id/audit', () => {
        it('lists project audit entries newest first, to any member', async () => {
          const id = await createProject(alice);
          await request(app)
            .patch(`/api/v1/projects/${id}`)
            .set(bearer(alice))
            .set('X-Request-Id', 'req-patch-1')
            .send({ name: 'Renamed' })
            .expect(200);
          await request(app)
            .post(`/api/v1/projects/${id}/members`)
            .set(bearer(alice))
            .send({ email: 'bob@example.com', role: 'viewer' })
            .expect(201);
          await request(app)
            .delete(`/api/v1/projects/${id}/members/${bob.id}`)
            .set(bearer(alice))
            .expect(200);
          await request(app)
            .post(`/api/v1/projects/${id}/members`)
            .set(bearer(alice))
            .send({ email: 'bob@example.com', role: 'viewer' })
            .expect(201);

          const res = await request(app).get(`/api/v1/projects/${id}/audit`).set(bearer(bob));

          expect(res.status).toBe(200);
          expect(res.body.data).toMatchObject({ page: 1, limit: 20, total: 5 });
          const items = res.body.data.items as {
            action: string;
            actorId: string;
            requestId: string;
            before: unknown;
            after: unknown;
          }[];
          expect(items.map((e) => e.action)).toEqual([
            'project.member.add',
            'project.member.remove',
            'project.member.add',
            'project.update',
            'project.create',
          ]);
          const update = items[3];
          expect(update).toMatchObject({
            actorId: alice.id,
            requestId: 'req-patch-1',
            before: { name: 'Customer 360' },
            after: { name: 'Renamed' },
          });
        });

        it('paginates, and validates the query', async () => {
          const id = await createProject(alice);
          await request(app)
            .patch(`/api/v1/projects/${id}`)
            .set(bearer(alice))
            .send({ name: 'Renamed' })
            .expect(200);

          const page2 = await request(app)
            .get(`/api/v1/projects/${id}/audit?page=2&limit=1`)
            .set(bearer(alice));
          expect(page2.body.data.items.map((e: { action: string }) => e.action)).toEqual([
            'project.create',
          ]);
          await request(app)
            .get(`/api/v1/projects/${id}/audit?page=0`)
            .set(bearer(alice))
            .expect(400);
        });

        it('keeps the delete entry after the project is gone', async () => {
          const id = await createProject(alice);
          await request(app).delete(`/api/v1/projects/${id}`).set(bearer(alice)).expect(204);

          const { items } = await repos.audit.listByProject(id, { skip: 0, limit: 10 });
          expect(items.map((e) => e.action)).toEqual(['project.delete', 'project.create']);
        });

        it('hides the log from non-members and requires authentication', async () => {
          const id = await createProject(alice);
          await request(app).get(`/api/v1/projects/${id}/audit`).set(bearer(bob)).expect(404);
          await request(app).get(`/api/v1/projects/${id}/audit`).expect(401);
        });
      });
    });
  });
}
