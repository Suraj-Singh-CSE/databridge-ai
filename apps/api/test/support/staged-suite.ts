import { randomBytes } from 'node:crypto';

import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import type { StagedRecord } from '../../src/modules/staged/staged.types.js';
import type { Repositories } from '../../src/repositories.js';

import { buildTestApp, fastPasswords } from './build-app.js';
import { FakeAiService } from './fakes.js';
import type { MappingsHarness } from './mappings-suite.js';
import { suggested } from './mappings-suite.js';
import type { StagedWrite } from './memory-repositories.js';

export interface StagedHarness extends MappingsHarness {
  /** Writes one run's staged rows and the source summary, as the Python standardise job does. */
  workerStage(repos: Repositories, write: StagedWrite): Promise<void>;
}

interface Session {
  id: string;
  token: string;
}

const PASSWORD = 'correct horse battery';
const bearer = (s: Session) => ({ Authorization: `Bearer ${s.token}` });
const newId = () => randomBytes(12).toString('hex');

function row(rowNumber: number, issues: StagedRecord['issues'] = []): StagedRecord {
  return {
    rowNumber,
    sourceRecordId: `C${String(rowNumber).padStart(6, '0')}`,
    fields: { phone: issues.length ? null : '+919820012345', email: 'a@example.com' },
    issues,
  };
}

/** Starting the standardise job and reading staged rows, against memory and MongoDB. */
export function defineStagedSuite(label: string, harness: StagedHarness): void {
  describe(`Standardise job and staged records API (${label})`, () => {
    let repos: Repositories;
    let ai: FakeAiService;
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

    async function newProject(session: Session): Promise<string> {
      const res = await request(app)
        .post('/api/v1/projects')
        .set(bearer(session))
        .send({ name: 'Customer 360' })
        .expect(201);
      return (res.body as { data: { project: { id: string } } }).data.project.id;
    }

    async function addSource(project = projectId): Promise<string> {
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
        rowCount: 3,
        columnCount: 3,
        uploadedBy: owner.id,
      });
      return id;
    }

    async function memberWith(role: 'viewer' | 'data_steward' | 'data_engineer') {
      const email = `${role}-${Math.random().toString(36).slice(2)}@example.com`;
      await repos.users.create({
        email,
        name: role,
        role: 'data_engineer',
        passwordHash: await fastPasswords.hash(PASSWORD),
      });
      const login = await request(app)
        .post('/api/v1/auth/login')
        .send({ email, password: PASSWORD })
        .expect(200);
      await request(app)
        .post(`/api/v1/projects/${projectId}/members`)
        .set(bearer(owner))
        .send({ email, role })
        .expect(201);
      const body = login.body as { data: { user: { id: string }; accessToken: string } };
      return { id: body.data.user.id, token: body.data.accessToken };
    }

    /** Profiled, mapped (three columns) and, unless told otherwise, every column decided. */
    async function mapped(decide: string[] = ['cust_id', 'ph', 'gender']): Promise<void> {
      await harness.markProfiled(repos, projectId, sourceId);
      await harness.workerSuggest(repos, {
        projectId,
        sourceId,
        suggestions: [
          suggested('cust_id', 0, null, 'High', 'source_record_id'),
          suggested('ph', 1, 'phone', 'High'),
          suggested('gender', 2, null, 'Low'),
        ],
      });
      for (const column of decide) {
        await repos.mappings.saveDecision(projectId, sourceId, {
          column,
          decision: column === 'gender' ? 'reject' : 'accept',
          target: column === 'ph' ? 'phone' : null,
          role: column === 'ph' ? 'field' : column === 'cust_id' ? 'source_record_id' : 'ignore',
          transform: null,
          schemaVersion: 1,
          decidedBy: owner.id,
          decidedAt: new Date(),
        });
      }
    }

    const startJob = (session: Session, payload: object = { sourceId }) =>
      request(app)
        .post(`/api/v1/projects/${projectId}/jobs`)
        .set(bearer(session))
        .send({ type: 'standardise', payload });

    const stagedUrl = (project = projectId, source = sourceId) =>
      `/api/v1/projects/${project}/sources/${source}/staged`;

    async function stage(runId = `${newId()}:1`): Promise<void> {
      await harness.workerStage(repos, {
        projectId,
        sourceId,
        runId,
        rows: [
          row(1),
          row(2, [{ field: 'phone', code: 'INVALID_PHONE' }]),
          row(3),
          row(4, [{ field: 'phone', code: 'INVALID_PHONE' }]),
          row(5),
        ],
        source: {
          status: 'standardised',
          standardisedAt: new Date('2026-11-22T10:00:00Z'),
          standardisation: {
            runId,
            rowCount: 5,
            rowsWithIssues: 2,
            issues: [{ field: 'phone', code: 'INVALID_PHONE', count: 2 }],
          },
        },
      });
    }

    beforeEach(async () => {
      repos = await harness.setup();
      ai = new FakeAiService();
      app = buildTestApp({ repos, aiService: ai });
      await register('first-admin@example.com');
      owner = await register('owner@example.com');
      projectId = await newProject(owner);
      sourceId = await addSource();
    });

    describe('POST /projects/:projectId/jobs (standardise)', () => {
      it('starts the job once every column has a decision', async () => {
        await mapped();
        const engineer = await memberWith('data_engineer');

        const res = await startJob(engineer);

        expect(res.status).toBe(202);
        expect(res.body.data.job).toMatchObject({ type: 'standardise', status: 'queued' });
        expect(ai.enqueued.map((e) => e.input.type)).toEqual(['standardise']);
        expect(ai.enqueued[0]?.input.payload).toEqual({ sourceId });
      });

      it('refuses while columns are still pending, with a plain message', async () => {
        await mapped(['cust_id']);

        const res = await startJob(owner);

        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({
          code: 'CONFLICT',
          message: expect.stringContaining('2 columns still need a decision') as string,
          details: { reason: 'MAPPING_NOT_APPROVED', pending: 2 },
        });
        expect(ai.enqueued).toEqual([]);
      });

      it('refuses an accept made on a suggestion that a mapping re-run changed', async () => {
        // Accepted as "ph -> phone" (the snapshot stored on the decision) ...
        await mapped();
        // ... then the mapping re-runs with the same suggestion: still fine.
        await harness.workerSuggest(repos, {
          projectId,
          sourceId,
          suggestions: [
            suggested('cust_id', 0, null, 'High', 'source_record_id'),
            suggested('ph', 1, 'phone', 'High'),
            suggested('gender', 2, null, 'Low'),
          ],
        });
        await startJob(owner).expect(202);
        await repos.jobs.finishIfActive(
          ai.enqueued[0]?.input.jobId ?? '',
          { status: 'cancelled', message: 'Cancelled', error: null },
          new Date(),
        );

        // A re-run that changes the target: the human never saw "ph -> email".
        await repos.mappings.deleteBySource(projectId, sourceId);
        await harness.workerSuggest(repos, {
          projectId,
          sourceId,
          suggestions: [
            suggested('cust_id', 0, null, 'High', 'source_record_id'),
            suggested('ph', 1, 'email', 'High'),
            suggested('gender', 2, null, 'Low'),
          ],
        });
        for (const column of ['cust_id', 'ph', 'gender']) {
          await repos.mappings.saveDecision(projectId, sourceId, {
            column,
            decision: column === 'gender' ? 'reject' : 'accept',
            target: column === 'ph' ? 'phone' : null,
            role: column === 'ph' ? 'field' : column === 'cust_id' ? 'source_record_id' : 'ignore',
            transform: null,
            schemaVersion: 1,
            decidedBy: owner.id,
            decidedAt: new Date(),
          });
        }

        const res = await startJob(owner);

        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({
          code: 'CONFLICT',
          message: 'Mapping changed after review for: ph. Review these columns again.',
          details: { reason: 'DECISION_OUTDATED', columns: ['ph'] },
        });

        // Overriding the column is a fresh human decision: allowed again.
        await request(app)
          .patch(`/api/v1/projects/${projectId}/sources/${sourceId}/mappings/ph`)
          .set(bearer(owner))
          .send({ decision: 'override', role: 'field', target: 'phone', transform: 'to_e164_in' })
          .expect(200);
        await startJob(owner).expect(202);
      });

      it('stores the accepted suggestion as a snapshot on the decision', async () => {
        await mapped([]);
        await request(app)
          .patch(`/api/v1/projects/${projectId}/sources/${sourceId}/mappings/ph`)
          .set(bearer(owner))
          .send({ decision: 'accept' })
          .expect(200);
        await request(app)
          .post(`/api/v1/projects/${projectId}/sources/${sourceId}/mappings/accept-high`)
          .set(bearer(owner))
          .expect(200);

        const decisions = await repos.mappings.listDecisions(projectId, sourceId);
        const byColumn = Object.fromEntries(decisions.map((d) => [d.column, d]));
        expect(byColumn.ph).toMatchObject({
          decision: 'accept',
          role: 'field',
          target: 'phone',
          transform: null,
        });
        expect(byColumn.cust_id).toMatchObject({
          decision: 'accept',
          role: 'source_record_id',
          target: null,
          transform: null,
        });
      });

      it('refuses before profiling and before the mapping has run', async () => {
        const notProfiled = await startJob(owner);
        expect(notProfiled.status).toBe(409);
        expect(notProfiled.body.error.details).toEqual({ reason: 'SOURCE_NOT_PROFILED' });
        expect(notProfiled.body.error.message).toMatch(/Profile and map this source/);

        await harness.markProfiled(repos, projectId, sourceId);
        const notMapped = await startJob(owner);
        expect(notMapped.status).toBe(409);
        expect(notMapped.body.error.details).toEqual({ reason: 'MAPPING_NOT_RUN' });
        expect(ai.enqueued).toEqual([]);
      });

      it('refuses a second standardise job for the same source', async () => {
        await mapped();
        await startJob(owner).expect(202);

        const res = await startJob(owner);

        expect(res.status).toBe(409);
        expect(res.body.error.message).toMatch(/already being standardised/);
      });

      it('lets a standardised source be mapped and standardised again', async () => {
        await mapped();
        await stage();

        await startJob(owner).expect(202);
        await request(app)
          .post(`/api/v1/projects/${projectId}/jobs`)
          .set(bearer(owner))
          .send({ type: 'mapping', payload: { sourceId } })
          .expect(202);
      });

      it('answers 403 to viewers and data stewards, 404 to non-members and unknown sources', async () => {
        await mapped();
        for (const role of ['viewer', 'data_steward'] as const) {
          const res = await startJob(await memberWith(role));
          expect(res.status).toBe(403);
          expect(res.body.error.code).toBe('FORBIDDEN');
        }
        const outsider = await register('outsider@example.com');
        expect((await startJob(outsider)).status).toBe(404);
        expect((await startJob(owner, { sourceId: newId() })).status).toBe(404);
        expect(ai.enqueued).toEqual([]);
      });

      it('validates the payload and needs a token', async () => {
        const bad = await startJob(owner, { sourceId: 'x' });
        expect(bad.status).toBe(400);
        expect(bad.body.error.code).toBe('VALIDATION_ERROR');
        const extra = await startJob(owner, { sourceId, rows: 10 });
        expect(extra.status).toBe(400);
        const anonymous = await request(app)
          .post(`/api/v1/projects/${projectId}/jobs`)
          .send({ type: 'standardise', payload: { sourceId } });
        expect(anonymous.status).toBe(401);
      });
    });

    describe('GET .../sources/:sourceId/staged', () => {
      it('pages through the staged rows with the summary, for any member', async () => {
        await stage();
        const viewer = await memberWith('viewer');

        const first = await request(app).get(`${stagedUrl()}?limit=2`).set(bearer(viewer));

        expect(first.status).toBe(200);
        expect(first.body.error).toBeNull();
        expect(first.body.data.source).toMatchObject({ id: sourceId, status: 'standardised' });
        expect(first.body.data.summary).toMatchObject({
          rowCount: 5,
          rowsWithIssues: 2,
          issues: [{ field: 'phone', code: 'INVALID_PHONE', count: 2 }],
        });
        expect(first.body.data.items).toEqual([
          row(1),
          row(2, [{ field: 'phone', code: 'INVALID_PHONE' }]),
        ]);
        expect(first.body.data.nextCursor).toBe('2');

        const second = await request(app)
          .get(`${stagedUrl()}?limit=2&cursor=2`)
          .set(bearer(viewer))
          .expect(200);
        expect(second.body.data.items.map((r: StagedRecord) => r.rowNumber)).toEqual([3, 4]);
        const last = await request(app)
          .get(`${stagedUrl()}?limit=2&cursor=4`)
          .set(bearer(viewer))
          .expect(200);
        expect(last.body.data.items.map((r: StagedRecord) => r.rowNumber)).toEqual([5]);
        expect(last.body.data.nextCursor).toBeNull();
      });

      it('filters to rows with issues and defaults to 50 rows', async () => {
        await stage();

        const res = await request(app)
          .get(`${stagedUrl()}?issues=only`)
          .set(bearer(owner))
          .expect(200);

        expect(res.body.data.items.map((r: StagedRecord) => r.rowNumber)).toEqual([2, 4]);
        expect(res.body.data.nextCursor).toBeNull();
      });

      it('shows only the run the source points at', async () => {
        await stage('older:1');
        await stage('newer:1');

        const res = await request(app).get(stagedUrl()).set(bearer(owner)).expect(200);

        expect(res.body.data.items).toHaveLength(5);
      });

      it('answers 409 before the source has been standardised', async () => {
        const res = await request(app).get(stagedUrl()).set(bearer(owner));

        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({
          code: 'CONFLICT',
          details: { reason: 'NOT_STANDARDISED' },
        });
      });

      it('validates limit, cursor and filter', async () => {
        await stage();
        for (const query of ['limit=0', 'limit=101', 'cursor=abc', 'cursor=-1', 'issues=some']) {
          const res = await request(app).get(`${stagedUrl()}?${query}`).set(bearer(owner));
          expect(res.status, query).toBe(400);
          expect(res.body.error.code).toBe('VALIDATION_ERROR');
        }
        await request(app).get(`${stagedUrl()}?limit=100`).set(bearer(owner)).expect(200);
      });

      it('answers 404 to non-members and unknown sources, 400 for bad ids, 401 without a token', async () => {
        await stage();
        const outsider = await register('outsider@example.com');
        expect((await request(app).get(stagedUrl()).set(bearer(outsider))).status).toBe(404);
        expect(
          (await request(app).get(stagedUrl(projectId, newId())).set(bearer(owner))).status,
        ).toBe(404);
        const otherProject = await newProject(owner);
        expect(
          (await request(app).get(stagedUrl(otherProject, sourceId)).set(bearer(owner))).status,
        ).toBe(404);
        expect((await request(app).get(stagedUrl(projectId, 'x')).set(bearer(owner))).status).toBe(
          400,
        );
        expect((await request(app).get(stagedUrl())).status).toBe(401);
      });

      it('deletes staged rows with their source and with the project', async () => {
        await stage();
        const runId = (await repos.sources.findById(projectId, sourceId))?.standardisation?.runId;
        const page = { runId: runId ?? '', afterRow: 0, limit: 10, issuesOnly: false };

        await request(app)
          .delete(`/api/v1/projects/${projectId}/sources/${sourceId}`)
          .set(bearer(owner))
          .expect(204);
        expect(await repos.stagedRecords.list(projectId, sourceId, page)).toEqual([]);

        sourceId = await addSource();
        await stage('kept:1');
        await request(app).delete(`/api/v1/projects/${projectId}`).set(bearer(owner)).expect(204);
        expect(
          await repos.stagedRecords.list(projectId, sourceId, { ...page, runId: 'kept:1' }),
        ).toEqual([]);
      });
    });
  });
}
