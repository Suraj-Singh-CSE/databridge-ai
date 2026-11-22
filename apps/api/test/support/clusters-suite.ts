import { randomBytes } from 'node:crypto';

import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { CANDIDATE_KEY_TYPES } from '../../src/modules/candidates/candidate.types.js';
import type {
  Cluster,
  ClusterSummary,
  GoldenRecord,
} from '../../src/modules/clusters/cluster.types.js';
import type { ScoreSummary } from '../../src/modules/scores/score.types.js';
import type { Repositories } from '../../src/repositories.js';

import { buildTestApp, fastPasswords } from './build-app.js';
import { FakeAiService } from './fakes.js';
import type { ClusterWrite } from './memory-repositories.js';
import type { ScoresHarness } from './scores-suite.js';

export interface ClustersHarness extends ScoresHarness {
  /** Writes one run's clusters, golden records and summary, as the Python clustering job does. */
  workerClusters(repos: Repositories, write: ClusterWrite): Promise<void>;
}

interface Session {
  id: string;
  token: string;
}

const PASSWORD = 'correct horse battery';
const bearer = (s: Session) => ({ Authorization: `Bearer ${s.token}` });
const newId = () => randomBytes(12).toString('hex');
const customerId = () => `C${randomBytes(6).toString('hex').toUpperCase()}`;
const NAMES = ['Asha Rao', 'A. Rao', 'Vikram Nair'];

interface Item extends Cluster {
  members: ({ id: string; sourceName: string; fields: Record<string, string | null> } | null)[];
  goldenRecord: GoldenRecord | null;
}
const itemsOf = (body: unknown) => (body as { data: { items: Item[] } }).data.items;

/** Starting the clustering job and reading clusters and golden records, against memory and MongoDB. */
export function defineClustersSuite(label: string, harness: ClustersHarness): void {
  describe(`Clustering job and clusters API (${label})`, () => {
    let repos: Repositories;
    let ai: FakeAiService;
    let app: Express;
    let admin: Session;
    let owner: Session;
    let projectId: string;
    /** Staged record ids of the CRM source, then the Billing source. */
    let crmIds: string[];
    let billingIds: string[];
    let billingSourceId: string;

    async function register(email: string): Promise<Session> {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ email, name: 'User', password: PASSWORD })
        .expect(201);
      const body = res.body as { data: { user: { id: string }; accessToken: string } };
      return { id: body.data.user.id, token: body.data.accessToken };
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

    async function addSource(name: string, rows: number): Promise<{ id: string; ids: string[] }> {
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
        rowCount: rows,
        columnCount: 3,
        uploadedBy: owner.id,
      });
      return { id, ids: await standardise(id, rows) };
    }

    async function standardise(sourceId: string, rows: number): Promise<string[]> {
      const runId = `${newId()}:1`;
      const ids = Array.from({ length: rows }, newId).sort();
      await harness.workerStage(repos, {
        projectId,
        sourceId,
        runId,
        rows: ids.map((id, index) => ({
          id,
          rowNumber: index + 1,
          sourceRecordId: `R${index + 1}`,
          fields: { full_name: NAMES[index % NAMES.length] ?? null, phone: '+919820012345' },
          issues: [],
        })),
        source: {
          status: 'standardised',
          standardisedAt: new Date('2026-11-22T10:00:00Z'),
          standardisation: { runId, rowCount: rows, rowsWithIssues: 0, issues: [] },
        },
      });
      return ids;
    }

    /** Candidate pairs over the current sources; returns the candidates run. */
    async function findCandidates(): Promise<string> {
      const sources = await repos.sources.listByProject(projectId);
      const [a, b] = [crmIds[0] ?? '', billingIds[0] ?? ''].sort() as [string, string];
      const runId = `${newId()}:1`;
      const zero = CANDIDATE_KEY_TYPES.map((key) => ({ key, count: 0 }));
      await harness.workerCandidates(repos, {
        projectId,
        pairs: [{ position: 1, recordA: a, recordB: b, keys: ['phone'] }],
        summary: {
          jobId: runId.split(':')[0] ?? '',
          runId,
          sources: sources.map((s) => ({
            sourceId: s.id,
            runId: s.standardisation?.runId ?? '',
            rowCount: s.rowCount ?? 0,
          })),
          recordCount: 5,
          possiblePairs: 10,
          pairCount: 1,
          reductionRatio: 0.9,
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

    /** Scores the one candidate pair as a match; returns the scoring summary. */
    async function score(candidatesRunId: string, aiReviewJobId?: string): Promise<ScoreSummary> {
      const [recordA, recordB] = [crmIds[0] ?? '', billingIds[0] ?? ''].sort() as [string, string];
      const runId = `${newId()}:1`;
      const summary: ScoreSummary = {
        jobId: runId.split(':')[0] ?? '',
        runId,
        candidatesRunId,
        pairCount: 1,
        bandCounts: [
          { band: 'match', count: 1 },
          { band: 'maybe', count: 0 },
          { band: 'non_match', count: 0 },
        ],
        thresholds: { match: 0.9, maybe: 0.5 },
        model: {
          method: 'defaults',
          emIterations: 0,
          emConverged: false,
          fallbackReason: 'too few pairs',
          matchProportion: 0.5,
          priorWeight: 0,
          fields: [],
        },
        finishedAt: new Date('2026-11-22T12:00:00Z'),
        aiReview: aiReviewJobId
          ? {
              jobId: aiReviewJobId,
              promptVersion: 'pair_review.v1',
              model: 'mock',
              confidenceThreshold: 0.8,
              pairCount: 0,
              reviewed: 0,
              same: 0,
              different: 0,
              unsure: 0,
              unavailable: 0,
              suggestedMatch: 0,
              suggestedNonMatch: 0,
              calls: 0,
              failedCalls: 0,
              finishedAt: new Date('2026-11-22T12:30:00Z'),
            }
          : null,
      };
      await harness.workerScores(repos, {
        projectId,
        summary,
        scores: [
          {
            position: 1,
            recordA,
            recordB,
            score: 0.999,
            band: 'match',
            matchWeight: 10,
            fieldLevels: { phone: 'exact' },
            reasons: [{ field: 'phone', level: 'exact', weight: 7.1, text: 'Same phone' }],
            aiStatus: null,
            aiDecision: null,
            aiConfidence: null,
            aiReason: null,
            aiModel: null,
            aiPromptVersion: null,
            reviewedAt: null,
            suggestedBand: 'match',
          },
        ],
      });
      return summary;
    }

    async function prepare(): Promise<ScoreSummary> {
      crmIds = (await addSource('crm_customers', 3)).ids;
      const billing = await addSource('billing_export', 2);
      billingIds = billing.ids;
      billingSourceId = billing.id;
      return score(await findCandidates());
    }

    function cluster(position: number, members: string[], extra: Partial<Cluster> = {}): Cluster {
      const [first = '', second = ''] = members;
      return {
        position,
        customerId: customerId(),
        memberRecordIds: members,
        size: members.length,
        confidence: members.length > 1 ? 0.999 : null,
        label: members.length > 1 ? 'High' : null,
        status: 'proposed',
        flags: [],
        reasons: [],
        aiSuggested: false,
        links:
          members.length > 1
            ? [{ recordA: first, recordB: second, score: 0.999, kind: 'match', tree: true }]
            : [],
        ...extra,
      };
    }

    function golden(item: Cluster): GoldenRecord {
      const [first = ''] = item.memberRecordIds;
      return {
        customerId: item.customerId,
        status: 'proposed',
        fields: { customer_id: item.customerId, full_name: 'Asha Rao', email: null },
        provenance: {
          full_name: {
            recordId: first,
            source: 'crm_customers',
            rule: item.size > 1 ? 'most_frequent' : 'only_value',
            alternatives: [
              {
                value: 'Asha Rao',
                count: item.size,
                recordIds: item.memberRecordIds,
                sources: ['crm_customers'],
              },
            ],
          },
          email: { recordId: null, source: null, rule: null, alternatives: [] },
        },
      };
    }

    /** Clusters as the worker writes them: a pair, a flagged AI-suggested pair, a single record. */
    async function buildClusters(scores: ScoreSummary): Promise<Cluster[]> {
      const [c1 = '', c2 = '', c3 = ''] = crmIds;
      const [b1 = '', b2 = ''] = billingIds;
      const clusters = [
        cluster(1, [c1, b1]),
        cluster(2, [c2, c3], {
          flags: ['needs_review', 'conflicting_evidence'],
          reasons: ['Contains records with different birth dates and different phones (1 pair)'],
          confidence: 0.7,
          label: 'Low',
          aiSuggested: true,
        }),
        cluster(3, [b2]),
      ];
      const runId = `${newId()}:1`;
      const summary: ClusterSummary = {
        jobId: runId.split(':')[0] ?? '',
        runId,
        scoresRunId: scores.runId,
        candidatesRunId: scores.candidatesRunId,
        aiReviewJobId: scores.aiReview?.jobId ?? null,
        recordCount: 5,
        clusterCount: 3,
        singletonCount: 1,
        multiRecordCount: 2,
        needsReviewCount: 1,
        aiSuggestedCount: 1,
        averageSize: 1.6667,
        largestCluster: 2,
        decisionCount: 0,
        settings: { includeAiSuggested: true, maxClusterSize: 6, sourceTrust: ['crm', 'billing'] },
        finishedAt: new Date('2026-11-22T13:00:00Z'),
      };
      await harness.workerClusters(repos, {
        projectId,
        clusters,
        golden: clusters.map(golden),
        summary,
      });
      return clusters;
    }

    const startJob = (session: Session | null, payload: object = {}) => {
      const req = request(app)
        .post(`/api/v1/projects/${projectId}/jobs`)
        .send({ type: 'clustering', payload });
      return session ? req.set(bearer(session)) : req;
    };
    const finish = async (jobId: string) =>
      repos.jobs.finishIfActive(
        jobId,
        { status: 'cancelled', message: 'Cancelled', error: null },
        new Date(),
      );
    const url = (path = '', project = projectId) => `/api/v1/projects/${project}/clusters${path}`;

    beforeEach(async () => {
      repos = await harness.setup();
      ai = new FakeAiService();
      app = buildTestApp({ repos, aiService: ai });
      crmIds = [];
      billingIds = [];
      admin = await register('first-admin@example.com');
      owner = await register('owner@example.com');
      const res = await request(app)
        .post('/api/v1/projects')
        .set(bearer(owner))
        .send({ name: 'Customer 360' })
        .expect(201);
      projectId = (res.body as { data: { project: { id: string } } }).data.project.id;
    });

    describe('POST /projects/:projectId/jobs (clustering)', () => {
      it('starts the project-level job for the owner, an admin and a data engineer', async () => {
        await prepare();
        const engineer = await memberWith('data_engineer');

        for (const session of [owner, admin, engineer]) {
          const res = await startJob(session);
          expect(res.status).toBe(202);
          expect(res.body.data.job).toMatchObject({
            type: 'clustering',
            status: 'queued',
            payload: {},
          });
          await finish((res.body as { data: { job: { id: string } } }).data.job.id);
        }
        expect(
          ai.enqueued.map(({ input }) => [input.type, input.payload, input.projectId]),
        ).toEqual([0, 1, 2].map(() => ['clustering', {}, projectId]));
      });

      it('answers 409 with a plain reason before scoring, and once the scores are outdated', async () => {
        crmIds = (await addSource('crm_customers', 3)).ids;
        billingIds = (await addSource('billing_export', 2)).ids;
        await findCandidates();
        const before = await startJob(owner);
        expect(before.status).toBe(409);
        expect(before.body.error).toMatchObject({
          code: 'CONFLICT',
          message: 'Score the candidate pairs before building clusters.',
          details: { reason: 'SCORES_NOT_RUN' },
        });

        await score(await findCandidates());
        await findCandidates(); // pairs found again: the scores are outdated
        const outdated = await startJob(owner);
        expect(outdated.status).toBe(409);
        expect(outdated.body.error.message).toContain('Score the candidate pairs again');
        expect(outdated.body.error.details).toEqual({ reason: 'SCORES_OUTDATED' });
        expect(ai.enqueued).toEqual([]);
      });

      it('answers 409 while scoring, an AI review or another clustering job is active', async () => {
        await prepare();
        for (const [type, reason] of [
          ['scoring', 'SCORING_RUNNING'],
          ['pair_review', 'PAIR_REVIEW_RUNNING'],
        ] as const) {
          const running = await repos.jobs.create({
            projectId,
            type,
            payload: {},
            createdBy: owner.id,
          });
          const blocked = await startJob(owner);
          expect(blocked.status, type).toBe(409);
          expect(blocked.body.error.details).toEqual({ reason });
          await finish(running.id);
        }
        await startJob(owner).expect(202);
        const busy = await startJob(owner);
        expect(busy.status).toBe(409);
        expect(busy.body.error.details).toEqual({ reason: 'CLUSTERING_RUNNING' });
      });

      it('refuses viewers and stewards (403), outsiders (404), bad payloads (400), no token (401)', async () => {
        await prepare();
        for (const role of ['viewer', 'data_steward'] as const) {
          const res = await startJob(await memberWith(role));
          expect(res.status, role).toBe(403);
          expect(res.body.error.code).toBe('FORBIDDEN');
        }
        expect((await startJob(await register('outsider@example.com'))).status).toBe(404);
        const bad = await startJob(owner, { maxClusterSize: 3 });
        expect(bad.status).toBe(400);
        expect(bad.body.error.code).toBe('VALIDATION_ERROR');
        expect((await startJob(null)).status).toBe(401);
        expect(ai.enqueued).toEqual([]);
      });
    });

    describe('GET .../clusters/summary', () => {
      it('returns the counts to any member', async () => {
        await buildClusters(await prepare());
        const viewer = await memberWith('viewer');

        const res = await request(app).get(url('/summary')).set(bearer(viewer));

        expect(res.status).toBe(200);
        expect(res.body.error).toBeNull();
        expect(res.body.data.outdated).toBe(false);
        expect(res.body.data.summary).toMatchObject({
          recordCount: 5,
          clusterCount: 3,
          singletonCount: 1,
          multiRecordCount: 2,
          needsReviewCount: 1,
          aiSuggestedCount: 1,
          averageSize: 1.6667,
          aiReviewJobId: null,
          settings: { includeAiSuggested: true, maxClusterSize: 6 },
          finishedAt: '2026-11-22T13:00:00.000Z',
        });
      });

      it('marks the clusters outdated once the pairs are scored or reviewed again', async () => {
        const scores = await prepare();
        await buildClusters(scores);
        await score(scores.candidatesRunId, newId()); // an AI review ran after clustering
        const reviewed = await request(app).get(url('/summary')).set(bearer(owner)).expect(200);
        expect(reviewed.body.data.outdated).toBe(true);

        await buildClusters(await score(scores.candidatesRunId));
        const fresh = await request(app).get(url('/summary')).set(bearer(owner)).expect(200);
        expect(fresh.body.data.outdated).toBe(false);
        await standardise(billingSourceId, 2); // new records: the scores no longer fit
        const restandardised = await request(app)
          .get(url('/summary'))
          .set(bearer(owner))
          .expect(200);
        expect(restandardised.body.data.outdated).toBe(true);
      });

      it('answers 409 before the first run, 404 to outsiders, 400 for bad input, 401 without a token', async () => {
        await prepare();
        const before = await request(app).get(url('/summary')).set(bearer(owner));
        expect(before.status).toBe(409);
        expect(before.body.error.details).toEqual({ reason: 'CLUSTERS_NOT_RUN' });
        await buildClusters(await score(await findCandidates()));
        const outsider = await register('outsider@example.com');
        expect((await request(app).get(url('/summary')).set(bearer(outsider))).status).toBe(404);
        expect((await request(app).get(url('/summary', newId())).set(bearer(owner))).status).toBe(
          404,
        );
        expect((await request(app).get(url('/summary', 'x')).set(bearer(owner))).status).toBe(400);
        expect((await request(app).get(url('/summary?x=1')).set(bearer(owner))).status).toBe(400);
        expect((await request(app).get(url('/summary'))).status).toBe(401);
      });
    });

    describe('GET .../clusters', () => {
      it('lists clusters with members, the golden record and its provenance, for any member', async () => {
        const built = await buildClusters(await prepare());
        const viewer = await memberWith('viewer');

        const res = await request(app).get(url()).set(bearer(viewer));

        expect(res.status).toBe(200);
        expect(res.body.data.outdated).toBe(false);
        expect(res.body.data.nextCursor).toBeNull();
        const items = itemsOf(res.body);
        expect(items.map((i) => [i.position, i.size, i.customerId])).toEqual(
          built.map((c) => [c.position, c.size, c.customerId]),
        );
        const [top] = items;
        if (!top) throw new Error('no cluster');
        expect(top).toMatchObject({ status: 'proposed', label: 'High', confidence: 0.999 });
        expect(top.members.map((m) => m?.sourceName)).toEqual(['crm_customers', 'billing_export']);
        expect(top.members[0]?.fields).toEqual({ full_name: 'Asha Rao', phone: '+919820012345' });
        expect(top.links).toEqual([
          {
            recordA: top.memberRecordIds[0],
            recordB: top.memberRecordIds[1],
            score: 0.999,
            kind: 'match',
            tree: true,
          },
        ]);
        expect(top.goldenRecord?.fields).toEqual({
          customer_id: top.customerId,
          full_name: 'Asha Rao',
          email: null,
        });
        expect(top.goldenRecord?.provenance.full_name).toEqual({
          recordId: top.memberRecordIds[0],
          source: 'crm_customers',
          rule: 'most_frequent',
          alternatives: [
            {
              value: 'Asha Rao',
              count: 2,
              recordIds: top.memberRecordIds,
              sources: ['crm_customers'],
            },
          ],
        });
        expect(top.goldenRecord?.provenance.email).toEqual({
          recordId: null,
          source: null,
          rule: null,
          alternatives: [],
        });
      });

      it('filters by flag, size and status, and pages by position', async () => {
        await buildClusters(await prepare());

        const flagged = await request(app)
          .get(url('?flag=needs_review'))
          .set(bearer(owner))
          .expect(200);
        expect(
          itemsOf(flagged.body).map((i) => [i.position, i.aiSuggested, i.reasons.length]),
        ).toEqual([[2, true, 1]]);
        const multi = await request(app).get(url('?minSize=2')).set(bearer(owner)).expect(200);
        expect(itemsOf(multi.body).map((i) => i.position)).toEqual([1, 2]);
        const approved = await request(app)
          .get(url('?status=approved'))
          .set(bearer(owner))
          .expect(200);
        expect(itemsOf(approved.body)).toEqual([]);

        const first = await request(app).get(url('?limit=2')).set(bearer(owner)).expect(200);
        expect(itemsOf(first.body).map((i) => i.position)).toEqual([1, 2]);
        expect(first.body.data.nextCursor).toBe('2');
        const last = await request(app)
          .get(url('?limit=2&cursor=2'))
          .set(bearer(owner))
          .expect(200);
        expect(itemsOf(last.body).map((i) => i.position)).toEqual([3]);
        expect(last.body.data.nextCursor).toBeNull();
      });

      it('validates the query (at most 100 clusters)', async () => {
        await buildClusters(await prepare());
        for (const query of [
          'status=done',
          'flag=odd',
          'minSize=0',
          'minSize=x',
          'limit=0',
          'limit=101',
          'cursor=abc',
          'other=1',
        ]) {
          const res = await request(app)
            .get(url(`?${query}`))
            .set(bearer(owner));
          expect(res.status, query).toBe(400);
          expect(res.body.error.code).toBe('VALIDATION_ERROR');
        }
        await request(app).get(url('?limit=100&flag=too_large')).set(bearer(owner)).expect(200);
      });

      it('answers 409 before the first run, 404 to outsiders, 401 without a token', async () => {
        await prepare();
        const before = await request(app).get(url()).set(bearer(owner));
        expect(before.status).toBe(409);
        expect(before.body.error.details).toEqual({ reason: 'CLUSTERS_NOT_RUN' });
        await buildClusters(await score(await findCandidates()));
        const outsider = await register('outsider@example.com');
        expect((await request(app).get(url()).set(bearer(outsider))).status).toBe(404);
        expect((await request(app).get(url('', newId())).set(bearer(owner))).status).toBe(404);
        expect((await request(app).get(url())).status).toBe(401);
      });
    });

    describe('GET .../clusters/:customerId', () => {
      it('returns one cluster with members and the golden record', async () => {
        const [, flagged] = await buildClusters(await prepare());
        if (!flagged) throw new Error('no cluster');
        const viewer = await memberWith('viewer');

        const res = await request(app)
          .get(url(`/${flagged.customerId}`))
          .set(bearer(viewer));

        expect(res.status).toBe(200);
        expect(res.body.data.outdated).toBe(false);
        const { cluster: found } = res.body.data as { cluster: Item };
        expect(found).toMatchObject({
          customerId: flagged.customerId,
          flags: ['needs_review', 'conflicting_evidence'],
          label: 'Low',
          aiSuggested: true,
        });
        expect(found.members.map((m) => m?.id)).toEqual(flagged.memberRecordIds);
        expect(found.goldenRecord?.customerId).toBe(flagged.customerId);
      });

      it('answers 404 for an unknown id, 400 for a malformed one, 409 before the first run, 401 without a token', async () => {
        await prepare();
        const before = await request(app)
          .get(url(`/${customerId()}`))
          .set(bearer(owner));
        expect(before.status).toBe(409);
        await buildClusters(await score(await findCandidates()));
        const unknown = await request(app)
          .get(url(`/${customerId()}`))
          .set(bearer(owner));
        expect(unknown.status).toBe(404);
        expect(unknown.body.error.code).toBe('NOT_FOUND');
        for (const id of ['c123', 'C12', 'Cxyzxyzxyzxy']) {
          expect(
            (
              await request(app)
                .get(url(`/${id}`))
                .set(bearer(owner))
            ).status,
            id,
          ).toBe(400);
        }
        const outsider = await register('outsider@example.com');
        expect(
          (
            await request(app)
              .get(url(`/${customerId()}`))
              .set(bearer(outsider))
          ).status,
        ).toBe(404);
        expect((await request(app).get(url(`/${customerId()}`))).status).toBe(401);
      });

      it('deletes clusters when a source is deleted and with the project', async () => {
        await buildClusters(await prepare());
        const [crm] = await repos.sources.listByProject(projectId);
        await request(app)
          .delete(`/api/v1/projects/${projectId}/sources/${crm?.id ?? ''}`)
          .set(bearer(owner))
          .expect(204);
        expect(await repos.clusters.findSummary(projectId)).toBeNull();

        await buildClusters(await prepare());
        const summary = await repos.clusters.findSummary(projectId);
        await request(app).delete(`/api/v1/projects/${projectId}`).set(bearer(owner)).expect(204);
        expect(await repos.clusters.findSummary(projectId)).toBeNull();
        expect(
          await repos.clusters.listClusters(projectId, {
            runId: summary?.runId ?? '',
            afterPosition: 0,
            limit: 10,
          }),
        ).toEqual([]);
      });
    });
  });
}
