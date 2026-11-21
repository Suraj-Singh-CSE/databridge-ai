import { randomBytes } from 'node:crypto';

import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ColumnProfile } from '../../src/modules/sources/column-profile.types.js';
import type { Repositories } from '../../src/repositories.js';

import type { Harness } from './api-suite.js';
import { buildTestApp, fastPasswords } from './build-app.js';
import type { ProfileWrite } from './memory-repositories.js';

export interface ProfilesHarness extends Harness {
  /** Writes column profiles and the source summary directly, as the Python profiler does. */
  workerProfile(repos: Repositories, write: ProfileWrite): Promise<void>;
}

interface Session {
  id: string;
  token: string;
}

const PASSWORD = 'correct horse battery';
const bearer = (s: Session) => ({ Authorization: `Bearer ${s.token}` });
const newId = () => randomBytes(12).toString('hex');

export function columnProfile(column: string, position: number): ColumnProfile {
  return {
    column,
    position,
    inferredType: 'email',
    rowCount: 10,
    emptyCount: 1,
    emptyPercent: 10,
    distinctCount: 9,
    uniquePercent: 100,
    min: null,
    max: null,
    minLength: 9,
    maxLength: 24,
    avgLength: 15.5,
    topValues: [{ value: '[EMAIL]', count: 1, percent: 10 }],
    samples: ['[EMAIL]'],
    patterns: [{ code: 'email', label: 'Email address', matchCount: 9, matchPercent: 100 }],
    flags: [{ code: 'PERSONAL_DATA', label: 'Personal data', detail: 'Values are masked.' }],
    personal: true,
    profileVersion: 1,
    createdAt: new Date('2026-11-21T10:00:00Z'),
  };
}

/** GET /projects/:projectId/sources/:sourceId/profile and profile clean-up. */
export function defineProfilesSuite(label: string, harness: ProfilesHarness): void {
  describe(`Source profiles API (${label})`, () => {
    let repos: Repositories;
    let app: Express;
    let owner: Session;
    let projectId: string;
    let sourceId: string;

    async function register(email: string): Promise<Session> {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ email, name: 'User', password: PASSWORD })
        .expect(201);
      const body = res.body as { data: { user: { id: string }; accessToken: string } };
      return { id: body.data.user.id, token: body.data.accessToken };
    }

    async function newProject(session: Session, name = 'Customer 360'): Promise<string> {
      const res = await request(app)
        .post('/api/v1/projects')
        .set(bearer(session))
        .send({ name })
        .expect(201);
      return (res.body as { data: { project: { id: string } } }).data.project.id;
    }

    async function addSource(project: string): Promise<string> {
      const id = newId();
      await repos.sources.create({
        id,
        projectId: project,
        name: 'CRM',
        systemName: null,
        originalFilename: 'crm.csv',
        fileKey: `projects/${project}/sources/${id}/original.csv`,
        format: 'csv',
        sizeBytes: 100,
        sha256: randomBytes(32).toString('hex'),
        rowCount: 10,
        columnCount: 2,
        uploadedBy: owner.id,
      });
      return id;
    }

    async function viewerSession(): Promise<Session> {
      const email = `viewer-${Math.random().toString(36).slice(2)}@example.com`;
      await repos.users.create({
        email,
        name: 'Viewer',
        role: 'viewer',
        passwordHash: await fastPasswords.hash(PASSWORD),
      });
      const login = await request(app)
        .post('/api/v1/auth/login')
        .send({ email, password: PASSWORD })
        .expect(200);
      await request(app)
        .post(`/api/v1/projects/${projectId}/members`)
        .set(bearer(owner))
        .send({ email, role: 'viewer' })
        .expect(201);
      const body = login.body as { data: { user: { id: string }; accessToken: string } };
      return { id: body.data.user.id, token: body.data.accessToken };
    }

    const profileUrl = (project = projectId, source = sourceId) =>
      `/api/v1/projects/${project}/sources/${source}/profile`;

    async function profiled(project = projectId, source = sourceId): Promise<void> {
      await harness.workerProfile(repos, {
        projectId: project,
        sourceId: source,
        // Saved out of order on purpose: the api returns file order.
        columns: [columnProfile('email', 1), columnProfile('id', 0)],
        source: {
          status: 'profiled',
          rowCount: 10,
          columnCount: 2,
          profiledAt: new Date('2026-11-21T10:00:05Z'),
        },
      });
    }

    beforeEach(async () => {
      repos = await harness.setup();
      app = buildTestApp({ repos });
      await register('first-admin@example.com');
      owner = await register('owner@example.com');
      projectId = await newProject(owner);
      sourceId = await addSource(projectId);
    });

    it('returns no columns before the source is profiled', async () => {
      const res = await request(app).get(profileUrl()).set(bearer(owner));

      expect(res.status).toBe(200);
      expect(res.body.error).toBeNull();
      expect(res.body.data.columns).toEqual([]);
      expect(res.body.data.source).toMatchObject({ id: sourceId, status: 'uploaded' });
      expect(res.body.data.source.profiledAt).toBeNull();
    });

    it('returns the column profiles in file order to any member, without storage keys', async () => {
      await profiled();
      const viewer = await viewerSession();

      const res = await request(app).get(profileUrl()).set(bearer(viewer));

      expect(res.status).toBe(200);
      expect(res.body.data.source).toMatchObject({
        id: sourceId,
        status: 'profiled',
        rowCount: 10,
        columnCount: 2,
        profiledAt: '2026-11-21T10:00:05.000Z',
      });
      expect(res.body.data.source.fileKey).toBeUndefined();
      expect(res.body.data.columns.map((c: ColumnProfile) => c.column)).toEqual(['id', 'email']);
      expect(res.body.data.columns[1]).toEqual({
        ...columnProfile('email', 1),
        createdAt: '2026-11-21T10:00:00.000Z',
      });
    });

    it('answers 404 to non-members and for unknown or foreign sources', async () => {
      await profiled();
      const outsider = await register('outsider@example.com');
      const other = await newProject(outsider, 'Other');
      const foreign = await addSource(other);

      const hidden = await request(app).get(profileUrl()).set(bearer(outsider));
      expect(hidden.status).toBe(404);
      expect(hidden.body.error.code).toBe('NOT_FOUND');
      await request(app).get(profileUrl(projectId, newId())).set(bearer(owner)).expect(404);
      // A source id from another project is not found through this project.
      await request(app).get(profileUrl(projectId, foreign)).set(bearer(owner)).expect(404);
    });

    it('validates ids and requires authentication', async () => {
      const bad = await request(app).get(profileUrl(projectId, 'nope')).set(bearer(owner));
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('VALIDATION_ERROR');
      await request(app).get(profileUrl('nope')).set(bearer(owner)).expect(400);
      const anonymous = await request(app).get(profileUrl());
      expect(anonymous.status).toBe(401);
      expect(anonymous.body.error.code).toBe('UNAUTHORIZED');
    });

    it('deletes the profile with its source and with its project', async () => {
      const second = await addSource(projectId);
      await profiled();
      await profiled(projectId, second);
      const otherProject = await newProject(owner, 'Other');
      const kept = await addSource(otherProject);
      await profiled(otherProject, kept);

      await request(app)
        .delete(`/api/v1/projects/${projectId}/sources/${sourceId}`)
        .set(bearer(owner))
        .expect(204);
      expect(await repos.columnProfiles.listBySource(projectId, sourceId)).toEqual([]);
      expect(await repos.columnProfiles.listBySource(projectId, second)).toHaveLength(2);

      await request(app).delete(`/api/v1/projects/${projectId}`).set(bearer(owner)).expect(204);
      expect(await repos.columnProfiles.listBySource(projectId, second)).toEqual([]);
      expect(await repos.columnProfiles.listBySource(otherProject, kept)).toHaveLength(2);
    });
  });
}
