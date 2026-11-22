import { randomBytes } from 'node:crypto';

import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { CANDIDATE_KEY_TYPES } from '../../src/modules/candidates/candidate.types.js';
import type { PairScore, ScoreBand, ScoreSummary } from '../../src/modules/scores/score.types.js';
import type { Repositories } from '../../src/repositories.js';

import { buildTestApp, fastPasswords } from './build-app.js';
import type { CandidatesHarness } from './candidates-suite.js';
import { FakeAiService } from './fakes.js';
import type { ScoreWrite } from './memory-repositories.js';

export interface ScoresHarness extends CandidatesHarness {
  /** Writes one run's scores and the project summary, as the Python scoring job does. */
  workerScores(repos: Repositories, write: ScoreWrite): Promise<void>;
}

interface Session {
  id: string;
  token: string;
}

const PASSWORD = 'correct horse battery';
const bearer = (s: Session) => ({ Authorization: `Bearer ${s.token}` });
const newId = () => randomBytes(12).toString('hex');
const FIELDS = ['full_name', 'phone', 'email', 'date_of_birth', 'city', 'pin_code', 'address'];

/** Starting the scoring job and reading pair scores, against memory and MongoDB. */
export function defineScoresSuite(label: string, harness: ScoresHarness): void {
  describe(`Scoring job and pair scores API (${label})`, () => {
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

    async function addSource(name: string): Promise<string> {
      const id = newId();
      await repos.sources.create({
        id,
        projectId,
        name,
        systemName: null,
        originalFilename: `${name}.csv`,
        fileKey: `projects/${projectId}/sources/${id}/original.csv`,
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
    async function standardise(sourceId: string): Promise<string> {
      const runId = `${newId()}:1`;
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

    /** Candidate pairs over the given sources' records (a1-a2, a1-b1, a2-b1); returns the run. */
    async function findCandidates(crm: string, billing: string): Promise<string> {
      const [a1 = '', a2 = ''] = records[crm] ?? [];
      const [b1 = ''] = records[billing] ?? [];
      const ordered = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);
      const pairs = [ordered(a1, b1), ordered(a1, a2), ordered(a2, b1)].map(
        ([recordA, recordB], index) => ({ position: index + 1, recordA, recordB, keys: ['phone'] }),
      );
      const crmSource = await repos.sources.findById(projectId, crm);
      const billingSource = await repos.sources.findById(projectId, billing);
      const runId = `${newId()}:1`;
      const zero = CANDIDATE_KEY_TYPES.map((key) => ({ key, count: 0 }));
      await harness.workerCandidates(repos, {
        projectId,
        pairs,
        summary: {
          jobId: runId.split(':')[0] ?? '',
          runId,
          sources: [crmSource, billingSource].map((s) => ({
            sourceId: s?.id ?? '',
            runId: s?.standardisation?.runId ?? '',
            rowCount: 2,
          })),
          recordCount: 4,
          possiblePairs: 6,
          pairCount: 3,
          reductionRatio: 0.5,
          pairsByKey: zero,
          pairsOnlyByKey: zero,
          oversizeBlocksSkipped: 0,
          oversizeBlocksByKey: zero,
          maxBlockSize: 200,
          finishedAt: new Date('2026-11-22T11:00:00Z'),
        },
      });
      return runId;
    }

    async function prepare(): Promise<{ crm: string; billing: string; candidatesRun: string }> {
      const crm = await addSource('CRM');
      const billing = await addSource('Billing');
      await standardise(crm);
      await standardise(billing);
      return { crm, billing, candidatesRun: await findCandidates(crm, billing) };
    }

    function score(
      position: number,
      recordA: string,
      recordB: string,
      value: number,
      band: ScoreBand,
    ): PairScore {
      const levels = Object.fromEntries(FIELDS.map((f) => [f, 'missing']));
      return {
        position,
        recordA,
        recordB,
        score: value,
        band,
        matchWeight: Math.log2(value / (1 - value)),
        fieldLevels: { ...levels, phone: band === 'non_match' ? 'different' : 'exact' },
        reasons: [
          band === 'non_match'
            ? { field: 'phone', level: 'different', weight: -11.5, text: 'Different phones' }
            : { field: 'phone', level: 'exact', weight: 7.1, text: 'Same phone' },
        ],
      };
    }

    /** Scores the three pairs: one match, one maybe, one non-match. */
    async function scorePairs(): Promise<{ crm: string; billing: string }> {
      const { crm, billing, candidatesRun } = await prepare();
      const pairs = await repos.candidates.listPairs(projectId, {
        runId: candidatesRun,
        afterPosition: 0,
        limit: 10,
      });
      const [p1, p2, p3] = pairs;
      if (!p1 || !p2 || !p3) throw new Error('no pairs');
      const runId = `${newId()}:1`;
      const summary: ScoreSummary = {
        jobId: runId.split(':')[0] ?? '',
        runId,
        candidatesRunId: candidatesRun,
        pairCount: 3,
        bandCounts: [
          { band: 'match', count: 1 },
          { band: 'maybe', count: 1 },
          { band: 'non_match', count: 1 },
        ],
        thresholds: { match: 0.9, maybe: 0.5 },
        model: {
          method: 'em',
          emIterations: 5,
          emConverged: true,
          fallbackReason: null,
          matchProportion: 0.97,
          priorWeight: 0,
          fields: [
            {
              field: 'phone',
              levels: [
                { level: 'exact', m: 0.99, u: 0.007, weight: 7.1 },
                { level: 'different', m: 0.001, u: 0.993, weight: -9.9 },
              ],
            },
          ],
        },
        finishedAt: new Date('2026-11-22T12:00:00Z'),
      };
      await harness.workerScores(repos, {
        projectId,
        summary,
        scores: [
          score(1, p1.recordA, p1.recordB, 0.999, 'match'),
          score(2, p2.recordA, p2.recordB, 0.7, 'maybe'),
          score(3, p3.recordA, p3.recordB, 0.01, 'non_match'),
        ],
      });
      return { crm, billing };
    }

    const startJob = (session: Session | null, payload: object = {}) => {
      const req = request(app)
        .post(`/api/v1/projects/${projectId}/jobs`)
        .send({ type: 'scoring', payload });
      return session ? req.set(bearer(session)) : req;
    };
    const finish = async (jobId: string) =>
      repos.jobs.finishIfActive(
        jobId,
        { status: 'cancelled', message: 'Cancelled', error: null },
        new Date(),
      );
    const summaryUrl = (project = projectId) => `/api/v1/projects/${project}/scores/summary`;
    const listUrl = (project = projectId) => `/api/v1/projects/${project}/scores`;

    beforeEach(async () => {
      repos = await harness.setup();
      ai = new FakeAiService();
      app = buildTestApp({ repos, aiService: ai });
      records = {};
      admin = await register('first-admin@example.com');
      owner = await register('owner@example.com');
      const res = await request(app)
        .post('/api/v1/projects')
        .set(bearer(owner))
        .send({ name: 'Customer 360' })
        .expect(201);
      projectId = (res.body as { data: { project: { id: string } } }).data.project.id;
    });

    describe('POST /projects/:projectId/jobs (scoring)', () => {
      it('starts the project-level job for the owner, an admin and a data engineer', async () => {
        await prepare();
        const engineer = await memberWith('data_engineer');

        for (const session of [owner, admin, engineer]) {
          const res = await startJob(session);
          expect(res.status).toBe(202);
          expect(res.body.data.job).toMatchObject({
            type: 'scoring',
            status: 'queued',
            payload: {},
          });
          await finish((res.body as { data: { job: { id: string } } }).data.job.id);
        }
        expect(
          ai.enqueued.map(({ input }) => [input.type, input.payload, input.projectId]),
        ).toEqual([0, 1, 2].map(() => ['scoring', {}, projectId]));
      });

      it('answers 409 with a plain reason before candidate pairs are found', async () => {
        await standardise(await addSource('CRM'));

        const res = await startJob(owner);

        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({
          code: 'CONFLICT',
          message: 'Find candidate pairs before scoring them.',
          details: { reason: 'CANDIDATES_NOT_RUN' },
        });
        expect(ai.enqueued).toEqual([]);
      });

      it('answers 409 when the candidate pairs are outdated', async () => {
        const { billing } = await prepare();
        await standardise(billing); // standardised again: the pairs point at old records

        const res = await startJob(owner);

        expect(res.status).toBe(409);
        expect(res.body.error.message).toContain('Find candidate pairs again');
        expect(res.body.error.details).toEqual({ reason: 'CANDIDATES_OUTDATED' });
      });

      it('answers 409 while a candidates or another scoring job is active', async () => {
        await prepare();
        const running = await repos.jobs.create({
          projectId,
          type: 'candidates',
          payload: {},
          createdBy: owner.id,
        });
        const blocked = await startJob(owner);
        expect(blocked.status).toBe(409);
        expect(blocked.body.error.details).toEqual({ reason: 'CANDIDATES_RUNNING' });

        await finish(running.id);
        await startJob(owner).expect(202);
        const busy = await startJob(owner);
        expect(busy.status).toBe(409);
        expect(busy.body.error.details).toEqual({ reason: 'SCORING_RUNNING' });
      });

      it('refuses viewers and stewards (403), outsiders (404), bad payloads (400), no token (401)', async () => {
        await prepare();
        for (const role of ['viewer', 'data_steward'] as const) {
          const res = await startJob(await memberWith(role));
          expect(res.status, role).toBe(403);
          expect(res.body.error.code).toBe('FORBIDDEN');
        }
        expect((await startJob(await register('outsider@example.com'))).status).toBe(404);
        const bad = await startJob(owner, { threshold: 0.5 });
        expect(bad.status).toBe(400);
        expect(bad.body.error.code).toBe('VALIDATION_ERROR');
        expect((await startJob(null)).status).toBe(401);
        expect(ai.enqueued).toEqual([]);
      });
    });

    describe('GET .../scores/summary', () => {
      it('returns band counts, thresholds and the model to any member', async () => {
        await scorePairs();
        const viewer = await memberWith('viewer');

        const res = await request(app).get(summaryUrl()).set(bearer(viewer));

        expect(res.status).toBe(200);
        expect(res.body.error).toBeNull();
        expect(res.body.data.outdated).toBe(false);
        const summary = res.body.data.summary as ScoreSummary;
        expect(summary).toMatchObject({
          pairCount: 3,
          thresholds: { match: 0.9, maybe: 0.5 },
          finishedAt: '2026-11-22T12:00:00.000Z',
        });
        expect(summary.bandCounts.map((b) => b.count)).toEqual([1, 1, 1]);
        expect(summary.model).toMatchObject({ method: 'em', emConverged: true });
        expect(summary.model.fallbackReason).toBeNull();
        expect(summary.model.fields[0]?.levels[0]).toEqual({
          level: 'exact',
          m: 0.99,
          u: 0.007,
          weight: 7.1,
        });
      });

      it('marks the scores outdated once candidate pairs are found again', async () => {
        const { crm, billing } = await scorePairs();
        await findCandidates(crm, billing);

        const res = await request(app).get(summaryUrl()).set(bearer(owner)).expect(200);

        expect(res.body.data.outdated).toBe(true);
      });

      it('marks the scores outdated when a source is standardised again', async () => {
        const { billing } = await scorePairs();
        await standardise(billing);

        const res = await request(app).get(summaryUrl()).set(bearer(owner)).expect(200);

        expect(res.body.data.outdated).toBe(true);
      });

      it('answers 409 before the first run', async () => {
        await prepare();
        const res = await request(app).get(summaryUrl()).set(bearer(owner));
        expect(res.status).toBe(409);
        expect(res.body.error.details).toEqual({ reason: 'SCORES_NOT_RUN' });
      });

      it('answers 404 to outsiders, 400 for bad input, 401 without a token', async () => {
        await scorePairs();
        const outsider = await register('outsider@example.com');
        expect((await request(app).get(summaryUrl()).set(bearer(outsider))).status).toBe(404);
        expect((await request(app).get(summaryUrl(newId())).set(bearer(owner))).status).toBe(404);
        expect((await request(app).get(summaryUrl('x')).set(bearer(owner))).status).toBe(400);
        expect((await request(app).get(`${summaryUrl()}?x=1`).set(bearer(owner))).status).toBe(400);
        expect((await request(app).get(summaryUrl())).status).toBe(401);
      });
    });

    describe('GET .../scores', () => {
      interface Side {
        id: string;
        sourceName: string;
        fields: Record<string, string | null>;
      }
      interface Item {
        position: number;
        score: number;
        band: ScoreBand;
        fieldLevels: Record<string, string>;
        reasons: { field: string; text: string; weight: number }[];
        recordA: Side | null;
        recordB: Side | null;
      }
      const itemsOf = (body: unknown) => (body as { data: { items: Item[] } }).data.items;

      it('lists one band with reasons and both records side by side, for any member', async () => {
        await scorePairs();
        const viewer = await memberWith('viewer');

        const res = await request(app).get(`${listUrl()}?band=match`).set(bearer(viewer));

        expect(res.status).toBe(200);
        expect(res.body.data.outdated).toBe(false);
        expect(res.body.data.nextCursor).toBeNull();
        const [top, ...rest] = itemsOf(res.body);
        expect(rest).toEqual([]);
        if (!top) throw new Error('no match');
        expect(top).toMatchObject({ position: 1, score: 0.999, band: 'match' });
        expect(top.reasons).toEqual([
          { field: 'phone', level: 'exact', weight: 7.1, text: 'Same phone' },
        ]);
        expect(Object.keys(top.fieldLevels).sort()).toEqual([...FIELDS].sort());
        expect(top.recordA?.sourceName).toBeDefined();
        expect(top.recordA?.fields).toEqual({ full_name: 'Asha Rao', phone: '+919820012345' });
        expect((top.recordA?.id ?? '') < (top.recordB?.id ?? '')).toBe(true);

        const maybe = await request(app).get(`${listUrl()}?band=maybe`).set(bearer(viewer));
        expect(itemsOf(maybe.body).map((i) => [i.position, i.band])).toEqual([[2, 'maybe']]);
        const none = await request(app).get(`${listUrl()}?band=non_match`).set(bearer(viewer));
        expect(itemsOf(none.body).map((i) => i.reasons[0]?.text)).toEqual(['Different phones']);
      });

      it('pages through every band by score, highest first', async () => {
        await scorePairs();

        const first = await request(app).get(`${listUrl()}?limit=2`).set(bearer(owner)).expect(200);
        expect(itemsOf(first.body).map((i) => i.score)).toEqual([0.999, 0.7]);
        expect(first.body.data.nextCursor).toBe('2');

        const last = await request(app)
          .get(`${listUrl()}?limit=2&cursor=2`)
          .set(bearer(owner))
          .expect(200);
        expect(itemsOf(last.body).map((i) => i.position)).toEqual([3]);
        expect(last.body.data.nextCursor).toBeNull();
      });

      it('shows a record gone after re-standardising as null, and the page as outdated', async () => {
        const { billing } = await scorePairs();
        await standardise(billing); // new rows, new ids

        const res = await request(app).get(listUrl()).set(bearer(owner)).expect(200);

        expect(res.body.data.outdated).toBe(true);
        const gone = itemsOf(res.body).filter((i) => i.recordA === null || i.recordB === null);
        expect(gone).toHaveLength(2);
      });

      it('validates band, limit and cursor (at most 100 scores)', async () => {
        await scorePairs();
        for (const query of ['band=yes', 'limit=0', 'limit=101', 'cursor=abc', 'other=1']) {
          const res = await request(app).get(`${listUrl()}?${query}`).set(bearer(owner));
          expect(res.status, query).toBe(400);
          expect(res.body.error.code).toBe('VALIDATION_ERROR');
        }
        await request(app).get(`${listUrl()}?limit=100&band=maybe`).set(bearer(owner)).expect(200);
      });

      it('answers 409 before the first run, 404 to outsiders, 401 without a token', async () => {
        const before = await request(app).get(listUrl()).set(bearer(owner));
        expect(before.status).toBe(409);
        expect(before.body.error.details).toEqual({ reason: 'SCORES_NOT_RUN' });
        await scorePairs();
        const outsider = await register('outsider@example.com');
        expect((await request(app).get(listUrl()).set(bearer(outsider))).status).toBe(404);
        expect((await request(app).get(listUrl(newId())).set(bearer(owner))).status).toBe(404);
        expect((await request(app).get(listUrl())).status).toBe(401);
      });

      it('deletes scores when a source is deleted and with the project', async () => {
        const { crm } = await scorePairs();
        await request(app)
          .delete(`/api/v1/projects/${projectId}/sources/${crm}`)
          .set(bearer(owner))
          .expect(204);
        expect(await repos.scores.findSummary(projectId)).toBeNull();

        records = {};
        await scorePairs();
        const runId = (await repos.scores.findSummary(projectId))?.runId ?? '';
        await request(app).delete(`/api/v1/projects/${projectId}`).set(bearer(owner)).expect(204);
        expect(await repos.scores.findSummary(projectId)).toBeNull();
        expect(
          await repos.scores.listScores(projectId, { runId, afterPosition: 0, limit: 10 }),
        ).toEqual([]);
      });
    });
  });
}
