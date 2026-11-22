import { randomBytes } from 'node:crypto';

import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  CANDIDATE_KEY_TYPES,
  type CandidatePair,
  type CandidateSummary,
} from '../../src/modules/candidates/candidate.types.js';
import type { Repositories } from '../../src/repositories.js';

import { buildTestApp, fastPasswords } from './build-app.js';
import { FakeAiService } from './fakes.js';
import type { CandidateWrite } from './memory-repositories.js';
import type { StagedHarness } from './staged-suite.js';

export interface CandidatesHarness extends StagedHarness {
  /** Writes one run's pairs and the project summary, as the Python candidates job does. */
  workerCandidates(repos: Repositories, write: CandidateWrite): Promise<void>;
}

interface Session {
  id: string;
  token: string;
}

const PASSWORD = 'correct horse battery';
const bearer = (s: Session) => ({ Authorization: `Bearer ${s.token}` });
const newId = () => randomBytes(12).toString('hex');
const counts = (by: Partial<Record<string, number>>) =>
  CANDIDATE_KEY_TYPES.map((key) => ({ key, count: by[key] ?? 0 }));

/** Starting the candidates job and reading candidate pairs, against memory and MongoDB. */
export function defineCandidatesSuite(label: string, harness: CandidatesHarness): void {
  describe(`Candidates job and candidate pairs API (${label})`, () => {
    let repos: Repositories;
    let ai: FakeAiService;
    let app: Express;
    let admin: Session;
    let owner: Session;
    let projectId: string;
    /** Staged record ids per source, in row order. */
    let records: Record<string, string[]>;

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

    async function addSource(name: string, project = projectId): Promise<string> {
      const id = newId();
      await repos.sources.create({
        id,
        projectId: project,
        name,
        systemName: null,
        originalFilename: `${name}.csv`,
        fileKey: `projects/${project}/sources/${id}/original.csv`,
        format: 'csv',
        sizeBytes: 100,
        sha256: randomBytes(32).toString('hex'),
        rowCount: 2,
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

    /** Two staged rows for the source, as the standardise worker writes them. */
    async function standardise(sourceId: string, runId = `${newId()}:1`): Promise<string> {
      const ids = [newId(), newId()].sort();
      records[sourceId] = ids;
      await harness.workerStage(repos, {
        projectId,
        sourceId,
        runId,
        rows: ids.map((id, index) => ({
          id,
          rowNumber: index + 1,
          sourceRecordId: `R${index + 1}`,
          fields: { full_name: 'Asha Rao', phone: '+919820012345' },
          issues: [],
        })),
        source: {
          status: 'standardised',
          standardisedAt: new Date('2026-11-22T10:00:00Z'),
          standardisation: { runId, rowCount: 2, rowsWithIssues: 0, issues: [] },
        },
      });
      return runId;
    }

    function summaryOf(
      runId: string,
      sources: { sourceId: string; runId: string }[],
      pairCount: number,
    ): CandidateSummary {
      return {
        jobId: runId.split(':')[0] ?? '',
        runId,
        sources: sources.map((s) => ({ ...s, rowCount: 2 })),
        recordCount: sources.length * 2,
        possiblePairs: 6,
        pairCount,
        reductionRatio: 1 - pairCount / 6,
        pairsByKey: counts({ phone: pairCount, name_tokens: 1 }),
        pairsOnlyByKey: counts({ phone: pairCount - 1 }),
        oversizeBlocksSkipped: 0,
        oversizeBlocksByKey: counts({}),
        maxBlockSize: 200,
        finishedAt: new Date('2026-11-22T11:00:00Z'),
      };
    }

    /** Two standardised sources (CRM, Billing) and three pairs over their four records. */
    async function findCandidates(): Promise<{ crm: string; billing: string }> {
      const crm = await addSource('CRM');
      const billing = await addSource('Billing');
      const crmRun = await standardise(crm);
      const billingRun = await standardise(billing);
      const [a1 = '', a2 = ''] = records[crm] ?? [];
      const [b1 = ''] = records[billing] ?? [];
      const pair = (position: number, x: string, y: string, keys: string[]): CandidatePair => ({
        position,
        recordA: x < y ? x : y,
        recordB: x < y ? y : x,
        keys,
      });
      const pairs = [
        pair(1, a1, b1, ['phone', 'name_tokens']),
        pair(2, a1, a2, ['phone']),
        pair(3, a2, b1, ['phone']),
      ];
      const runId = `${newId()}:1`;
      await harness.workerCandidates(repos, {
        projectId,
        pairs,
        summary: summaryOf(
          runId,
          [
            { sourceId: crm, runId: crmRun },
            { sourceId: billing, runId: billingRun },
          ],
          3,
        ),
      });
      return { crm, billing };
    }

    const startJob = (session: Session | null, payload: object = {}) => {
      const req = request(app)
        .post(`/api/v1/projects/${projectId}/jobs`)
        .send({ type: 'candidates', payload });
      return session ? req.set(bearer(session)) : req;
    };
    const summaryUrl = (project = projectId) => `/api/v1/projects/${project}/candidates/summary`;
    const listUrl = (project = projectId) => `/api/v1/projects/${project}/candidates`;

    beforeEach(async () => {
      repos = await harness.setup();
      ai = new FakeAiService();
      app = buildTestApp({ repos, aiService: ai });
      records = {};
      admin = await register('first-admin@example.com');
      owner = await register('owner@example.com');
      projectId = await newProject(owner);
    });

    describe('POST /projects/:projectId/jobs (candidates)', () => {
      it('starts the project-level job for the owner, an admin and a data engineer', async () => {
        await standardise(await addSource('CRM'));
        const engineer = await memberWith('data_engineer');

        for (const session of [owner, admin, engineer]) {
          const res = await startJob(session);
          expect(res.status).toBe(202);
          expect(res.body.data.job).toMatchObject({
            type: 'candidates',
            status: 'queued',
            payload: {},
          });
          // Finish it so the next start is not refused as busy.
          const { job } = (res.body as { data: { job: { id: string } } }).data;
          await repos.jobs.finishIfActive(
            job.id,
            { status: 'cancelled', message: 'Cancelled', error: null },
            new Date(),
          );
        }
        expect(
          ai.enqueued.map(({ input }) => [input.type, input.payload, input.projectId]),
        ).toEqual([0, 1, 2].map(() => ['candidates', {}, projectId]));
      });

      it('answers 409 with a plain reason when no source is standardised', async () => {
        const res = await startJob(owner);
        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({
          code: 'CONFLICT',
          details: { reason: 'NO_STANDARDISED_SOURCES' },
        });
        const crm = await addSource('CRM');
        await harness.markProfiled(repos, projectId, crm);
        expect((await startJob(owner)).body.error.details.reason).toBe('NO_STANDARDISED_SOURCES');
        expect(ai.enqueued).toEqual([]);
      });

      it('answers 409 when a source changed after it was standardised', async () => {
        await standardise(await addSource('CRM'));
        const billing = await addSource('Billing');
        await standardise(billing);
        await harness.markProfiled(repos, projectId, billing); // profiled again

        const res = await startJob(owner);

        expect(res.status).toBe(409);
        expect(res.body.error.message).toContain('Billing');
        expect(res.body.error.details).toEqual({
          reason: 'STANDARDISATION_OUTDATED',
          sourceIds: [billing],
        });
      });

      it('answers 409 while a standardise or another candidates job is active', async () => {
        const crm = await addSource('CRM');
        await standardise(crm);
        const running = await repos.jobs.create({
          projectId,
          type: 'standardise',
          payload: { sourceId: crm },
          createdBy: owner.id,
        });
        const blocked = await startJob(owner);
        expect(blocked.status).toBe(409);
        expect(blocked.body.error.details).toEqual({ reason: 'STANDARDISE_RUNNING' });

        await repos.jobs.finishIfActive(
          running.id,
          { status: 'cancelled', message: 'Cancelled', error: null },
          new Date(),
        );
        await startJob(owner).expect(202);
        const busy = await startJob(owner);
        expect(busy.status).toBe(409);
        expect(busy.body.error.details).toEqual({ reason: 'CANDIDATES_RUNNING' });
      });

      it('refuses viewers and stewards (403), outsiders (404), bad payloads (400), no token (401)', async () => {
        await standardise(await addSource('CRM'));
        for (const role of ['viewer', 'data_steward'] as const) {
          const res = await startJob(await memberWith(role));
          expect(res.status, role).toBe(403);
          expect(res.body.error.code).toBe('FORBIDDEN');
        }
        expect((await startJob(await register('outsider@example.com'))).status).toBe(404);
        const bad = await startJob(owner, { sourceId: newId() });
        expect(bad.status).toBe(400);
        expect(bad.body.error.code).toBe('VALIDATION_ERROR');
        expect((await startJob(null)).status).toBe(401);
        expect(ai.enqueued).toEqual([]);
      });
    });

    describe('GET .../candidates/summary', () => {
      it('returns the last run summary to any member', async () => {
        await findCandidates();
        const viewer = await memberWith('viewer');

        const res = await request(app).get(summaryUrl()).set(bearer(viewer));

        expect(res.status).toBe(200);
        expect(res.body.error).toBeNull();
        expect(res.body.data.outdated).toBe(false);
        expect(res.body.data.summary).toMatchObject({
          recordCount: 4,
          pairCount: 3,
          oversizeBlocksSkipped: 0,
          maxBlockSize: 200,
          finishedAt: '2026-11-22T11:00:00.000Z',
        });
        expect(res.body.data.summary.pairsByKey).toEqual(counts({ phone: 3, name_tokens: 1 }));
        expect(res.body.data.summary.reductionRatio).toBeCloseTo(0.5);
      });

      it('marks the summary outdated once a source is standardised again', async () => {
        const { billing } = await findCandidates();
        await standardise(billing);

        const res = await request(app).get(summaryUrl()).set(bearer(owner)).expect(200);

        expect(res.body.data.outdated).toBe(true);
      });

      it('answers 409 before the first run', async () => {
        const res = await request(app).get(summaryUrl()).set(bearer(owner));
        expect(res.status).toBe(409);
        expect(res.body.error.details).toEqual({ reason: 'CANDIDATES_NOT_RUN' });
      });

      it('answers 404 to outsiders, 400 for bad input, 401 without a token', async () => {
        await findCandidates();
        const outsider = await register('outsider@example.com');
        expect((await request(app).get(summaryUrl()).set(bearer(outsider))).status).toBe(404);
        expect((await request(app).get(summaryUrl(newId())).set(bearer(owner))).status).toBe(404);
        expect((await request(app).get(summaryUrl('x')).set(bearer(owner))).status).toBe(400);
        expect((await request(app).get(`${summaryUrl()}?x=1`).set(bearer(owner))).status).toBe(400);
        expect((await request(app).get(summaryUrl())).status).toBe(401);
      });
    });

    describe('GET .../candidates', () => {
      it('pages through pairs with both records side by side, for any member', async () => {
        const { crm, billing } = await findCandidates();
        const viewer = await memberWith('viewer');

        const first = await request(app).get(`${listUrl()}?limit=2`).set(bearer(viewer));

        expect(first.status).toBe(200);
        expect(first.body.data.outdated).toBe(false);
        expect(first.body.data.summary.pairCount).toBe(3);
        interface Side {
          id: string;
          sourceId: string;
          sourceName: string;
          rowNumber: number;
          sourceRecordId: string;
          fields: Record<string, string | null>;
          issues: unknown[];
        }
        const body = first.body as {
          data: { items: { position: number; keys: string[]; recordA: Side; recordB: Side }[] };
        };
        const top = body.data.items[0];
        if (!top) throw new Error('no pairs');
        expect(top.position).toBe(1);
        expect(top.keys).toEqual(['phone', 'name_tokens']);
        const sides = [top.recordA, top.recordB];
        expect(sides.map((r) => r.sourceName).sort()).toEqual(['Billing', 'CRM']);
        expect(sides.map((r) => r.sourceId).sort()).toEqual([crm, billing].sort());
        expect(top.recordA.id < top.recordB.id).toBe(true);
        expect([1, 2]).toContain(top.recordA.rowNumber);
        expect(top.recordA.sourceRecordId).toMatch(/^R\d$/);
        expect(top.recordA.fields).toEqual({ full_name: 'Asha Rao', phone: '+919820012345' });
        expect(top.recordA.issues).toEqual([]);
        expect(first.body.data.nextCursor).toBe('2');

        const last = await request(app)
          .get(`${listUrl()}?limit=2&cursor=2`)
          .set(bearer(viewer))
          .expect(200);
        expect(last.body.data.items.map((p: { position: number }) => p.position)).toEqual([3]);
        expect(last.body.data.nextCursor).toBeNull();
      });

      it('shows a record gone after re-standardising as null, and the page as outdated', async () => {
        const { billing } = await findCandidates();
        await standardise(billing); // new rows, new ids

        const res = await request(app).get(listUrl()).set(bearer(owner)).expect(200);

        expect(res.body.data.outdated).toBe(true);
        const { items } = (
          res.body as { data: { items: { recordA: unknown; recordB: unknown }[] } }
        ).data;
        expect(items).toHaveLength(3);
        expect(items[1]?.recordA).not.toBeNull();
        const gone = items.filter((p) => p.recordA === null || p.recordB === null);
        expect(gone).toHaveLength(2);
      });

      it('validates limit and cursor (at most 100 pairs)', async () => {
        await findCandidates();
        for (const query of ['limit=0', 'limit=101', 'cursor=abc', 'cursor=-1', 'other=1']) {
          const res = await request(app).get(`${listUrl()}?${query}`).set(bearer(owner));
          expect(res.status, query).toBe(400);
          expect(res.body.error.code).toBe('VALIDATION_ERROR');
        }
        await request(app).get(`${listUrl()}?limit=100`).set(bearer(owner)).expect(200);
      });

      it('answers 409 before the first run, 404 to outsiders, 401 without a token', async () => {
        const before = await request(app).get(listUrl()).set(bearer(owner));
        expect(before.status).toBe(409);
        expect(before.body.error.details).toEqual({ reason: 'CANDIDATES_NOT_RUN' });
        await findCandidates();
        const outsider = await register('outsider@example.com');
        expect((await request(app).get(listUrl()).set(bearer(outsider))).status).toBe(404);
        expect((await request(app).get(listUrl())).status).toBe(401);
      });

      it('deletes pairs when a source is deleted and with the project', async () => {
        const { crm } = await findCandidates();
        await request(app)
          .delete(`/api/v1/projects/${projectId}/sources/${crm}`)
          .set(bearer(owner))
          .expect(204);
        expect(await repos.candidates.findSummary(projectId)).toBeNull();

        await findCandidates();
        const runId = (await repos.candidates.findSummary(projectId))?.runId ?? '';
        await request(app).delete(`/api/v1/projects/${projectId}`).set(bearer(owner)).expect(204);
        expect(await repos.candidates.findSummary(projectId)).toBeNull();
        expect(
          await repos.candidates.listPairs(projectId, { runId, afterPosition: 0, limit: 10 }),
        ).toEqual([]);
      });
    });
  });
}
