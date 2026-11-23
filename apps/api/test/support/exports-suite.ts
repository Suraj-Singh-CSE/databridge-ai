import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Cluster } from '../../src/modules/clusters/cluster.types.js';
import type { ExportRecord } from '../../src/modules/exports/export.types.js';
import type { Repositories } from '../../src/repositories.js';
import type { LocalDiskStorage } from '../../src/storage/local-disk.storage.js';

import { buildTestApp, fastPasswords, tempStorage } from './build-app.js';
import type { ClustersHarness } from './clusters-suite.js';
import { FakeAiService } from './fakes.js';
import * as fixtures from './pipeline-fixtures.js';
import type { PipelineContext } from './pipeline-fixtures.js';

export interface ExportsHarness extends ClustersHarness {
  /** Saves an export record as the Python export job does (the file is written separately). */
  workerExport(repos: Repositories, record: ExportRecord): Promise<void>;
}

interface Session {
  id: string;
  token: string;
}

type Role = 'viewer' | 'data_steward' | 'data_engineer';

const PASSWORD = 'correct horse battery';
const bearer = (s: Session) => ({ Authorization: `Bearer ${s.token}` });
const newId = () => randomBytes(12).toString('hex');
const CSV = Buffer.from("﻿customer_id,full_name\r\nC000000000001,'+91 test\r\n", 'utf8');
const XLSX = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), randomBytes(64)]);

/** Starting `export` jobs and listing, downloading and deleting exports (memory and MongoDB). */
export function defineExportsSuite(label: string, harness: ExportsHarness): void {
  describe(`Export job and exports API (${label})`, () => {
    let repos: Repositories;
    let ai: FakeAiService;
    let storage: LocalDiskStorage;
    let app: Express;
    let admin: Session;
    let owner: Session;
    let projectId: string;
    let clusters: Cluster[];

    async function register(email: string): Promise<Session> {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ email, name: 'User', password: PASSWORD })
        .expect(201);
      const body = res.body as { data: { user: { id: string }; accessToken: string } };
      return { id: body.data.user.id, token: body.data.accessToken };
    }

    async function memberWith(role: Role, project = projectId): Promise<Session> {
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
        .post(`/api/v1/projects/${project}/members`)
        .set(bearer(owner))
        .send({ email, role })
        .expect(201);
      const body = login.body as { data: { user: { id: string }; accessToken: string } };
      return { id: body.data.user.id, token: body.data.accessToken };
    }

    const pipeline = (): PipelineContext => ({ repos, harness, projectId, ownerId: owner.id });
    const findCandidates = (pair: [string, string]) => fixtures.findCandidates(pipeline(), pair);

    /** Sources, pairs, scores and three clusters (one pair, two singles); nothing approved. */
    async function prepare(): Promise<void> {
      ({ clusters } = await fixtures.prepareClusters(pipeline()));
    }

    async function approveFirst(): Promise<void> {
      const [top] = clusters;
      await request(app)
        .post(`/api/v1/projects/${projectId}/clusters/${top?.customerId ?? ''}/approve`)
        .set(bearer(owner))
        .send({})
        .expect(200);
    }

    const startExport = (session: Session | null, payload: object, project = projectId) => {
      const req = request(app)
        .post(`/api/v1/projects/${project}/jobs`)
        .send({ type: 'export', payload });
      return session ? req.set(bearer(session)) : req;
    };
    const finish = (jobId: string) =>
      repos.jobs.finishIfActive(
        jobId,
        { status: 'cancelled', message: 'Cancelled', error: null },
        new Date(),
      );
    const url = (path = '', project = projectId) => `/api/v1/projects/${project}/exports${path}`;

    async function actions(): Promise<string[]> {
      const page = await repos.audit.listByProject(projectId, { skip: 0, limit: 100 });
      return page.items.map((e) => e.action);
    }

    /** An export as the worker leaves it: the file in storage and its record. */
    async function writtenExport(
      format: 'csv' | 'xlsx' = 'csv',
      project = projectId,
    ): Promise<ExportRecord> {
      const id = newId();
      const body = format === 'csv' ? CSV : XLSX;
      const fileKey = `projects/${project}/exports/${id}.${format}`;
      const stored = await storage.put(fileKey, Readable.from([body]), {
        contentType: 'application/octet-stream',
      });
      const record: ExportRecord = {
        id,
        projectId: project,
        jobId: id,
        format,
        scope: 'approved',
        includeSources: false,
        rowCount: 1,
        bytes: stored.sizeBytes,
        sha256: stored.sha256,
        fileKey,
        clusteringRunId: 'job:1',
        schemaVersion: 1,
        status: 'ready',
        createdBy: owner.id,
        createdAt: new Date('2026-11-23T09:30:00Z'),
      };
      await harness.workerExport(repos, record);
      return record;
    }

    beforeEach(async () => {
      repos = await harness.setup();
      ai = new FakeAiService();
      storage = tempStorage();
      app = buildTestApp({ repos, aiService: ai, storage });
      clusters = [];
      admin = await register('first-admin@example.com');
      owner = await register('owner@example.com');
      const res = await request(app)
        .post('/api/v1/projects')
        .set(bearer(owner))
        .send({ name: 'Customer 360 (Pilot)!' })
        .expect(201);
      projectId = (res.body as { data: { project: { id: string } } }).data.project.id;
    });

    describe('POST /projects/:projectId/jobs (export)', () => {
      it('starts for the owner, an admin, a data engineer and a data steward; audited', async () => {
        await prepare();
        await approveFirst();
        const engineer = await memberWith('data_engineer');
        const steward = await memberWith('data_steward');

        for (const session of [owner, admin, engineer, steward]) {
          const res = await startExport(session, { format: 'csv' });
          expect(res.status).toBe(202);
          const job = (res.body as { data: { job: { id: string; payload: unknown } } }).data.job;
          expect(job.payload).toEqual({ format: 'csv', scope: 'approved', includeSources: false });
          await finish(job.id);
        }
        expect(ai.enqueued.map(({ input }) => input.type)).toEqual([
          'export',
          'export',
          'export',
          'export',
        ]);
        const page = await repos.audit.listByProject(projectId, { skip: 0, limit: 100 });
        const starts = page.items.filter(
          (e) => e.action === 'job.create' && (e.after as { type?: string }).type === 'export',
        );
        expect(starts).toHaveLength(4);
      });

      it('answers 401 without a token, 403 for a viewer and 404 for a non-member', async () => {
        await prepare();
        await approveFirst();
        const viewer = await memberWith('viewer');
        const stranger = await register('stranger@example.com');

        expect((await startExport(null, { format: 'csv' })).status).toBe(401);
        const forbidden = await startExport(viewer, { format: 'csv' });
        expect(forbidden.status).toBe(403);
        expect(forbidden.body.error.code).toBe('FORBIDDEN');
        const hidden = await startExport(stranger, { format: 'csv' });
        expect(hidden.status).toBe(404);
        expect(ai.enqueued).toEqual([]);
      });

      it('validates the payload', async () => {
        await prepare();
        for (const payload of [
          {},
          { format: 'pdf' },
          { format: 'csv', scope: 'some' },
          { format: 'csv', includeSources: 'yes' },
          { format: 'csv', path: '../../etc' },
        ]) {
          const res = await startExport(owner, payload);
          expect(res.status).toBe(400);
          expect(res.body.error.code).toBe('VALIDATION_ERROR');
        }
        expect(ai.enqueued).toEqual([]);
      });

      it('answers 409 before clustering, with nothing approved, when outdated or clustering', async () => {
        const early = await startExport(owner, { format: 'csv', scope: 'all' });
        expect(early.status).toBe(409);
        expect(early.body.error.details).toEqual({ reason: 'CLUSTERS_NOT_RUN' });

        await prepare();
        const none = await startExport(owner, { format: 'xlsx' });
        expect(none.status).toBe(409);
        expect(none.body.error).toMatchObject({
          code: 'CONFLICT',
          message: expect.stringContaining('No customer is approved yet') as string,
          details: { reason: 'NOTHING_APPROVED' },
        });
        const all = await startExport(owner, { format: 'xlsx', scope: 'all' });
        expect(all.status).toBe(202);
        await finish((all.body as { data: { job: { id: string } } }).data.job.id);

        const running = await repos.jobs.create({
          projectId,
          type: 'clustering',
          payload: {},
          createdBy: owner.id,
        });
        const busy = await startExport(owner, { format: 'csv', scope: 'all' });
        expect(busy.status).toBe(409);
        expect(busy.body.error.details).toEqual({ reason: 'CLUSTERING_RUNNING' });
        await finish(running.id);

        const [a = '', b = ''] = clusters[0]?.memberRecordIds ?? [];
        await findCandidates([a, b]); // pairs found again: the clusters are outdated
        const outdated = await startExport(owner, { format: 'csv', scope: 'all' });
        expect(outdated.status).toBe(409);
        expect(outdated.body.error.details).toEqual({ reason: 'CLUSTERS_OUTDATED' });
        expect(ai.enqueued.map(({ input }) => input.payload)).toEqual([
          { format: 'xlsx', scope: 'all', includeSources: false },
        ]);
      });
    });

    describe('GET /projects/:projectId/exports', () => {
      it('lists exports newest first for any member, without the storage key', async () => {
        const viewer = await memberWith('viewer');
        const older = await writtenExport('xlsx');
        const newer = await writtenExport('csv');
        await repos.exports.delete(projectId, newer.id);
        await harness.workerExport(repos, {
          ...newer,
          createdAt: new Date('2026-11-23T10:05:00Z'),
        });

        const res = await request(app).get(url()).set(bearer(viewer)).expect(200);
        const items = (res.body as { data: { items: Record<string, unknown>[] } }).data.items;
        expect(items.map((i) => i.id)).toEqual([newer.id, older.id]);
        expect(items[0]).toMatchObject({
          format: 'csv',
          scope: 'approved',
          rowCount: 1,
          bytes: CSV.length,
          status: 'ready',
          filename: 'customers-customer-360-pilot-20261123-1005.csv',
        });
        expect(items[0]).not.toHaveProperty('fileKey');

        const limited = await request(app).get(url('?limit=1')).set(bearer(viewer)).expect(200);
        expect((limited.body as { data: { items: unknown[] } }).data.items).toHaveLength(1);
        await request(app).get(url('?limit=0')).set(bearer(viewer)).expect(400);
      });

      it('answers 401, 404 for non-members and 400 for a bad project id', async () => {
        const stranger = await register('stranger@example.com');
        await request(app).get(url()).expect(401);
        const hidden = await request(app).get(url()).set(bearer(stranger));
        expect(hidden.status).toBe(404);
        await request(app).get(url('', 'not-an-id')).set(bearer(owner)).expect(400);
      });

      it('shows one export; 404 for an unknown or another project’s export', async () => {
        const record = await writtenExport();
        const res = await request(app)
          .get(url(`/${record.id}`))
          .set(bearer(owner))
          .expect(200);
        expect(res.body.data.export).toMatchObject({ id: record.id, sha256: record.sha256 });

        await request(app)
          .get(url(`/${newId()}`))
          .set(bearer(owner))
          .expect(404);
        await request(app).get(url('/..%2F..%2Fetc')).set(bearer(owner)).expect(400);
        const other = await request(app)
          .post('/api/v1/projects')
          .set(bearer(owner))
          .send({ name: 'Other' })
          .expect(201);
        const otherId = (other.body as { data: { project: { id: string } } }).data.project.id;
        await request(app)
          .get(url(`/${record.id}`, otherId))
          .set(bearer(owner))
          .expect(404);
      });
    });

    describe('GET /projects/:projectId/exports/:exportId/download', () => {
      it('streams the CSV as an attachment for a viewer, no-store and nosniff; audited', async () => {
        const viewer = await memberWith('viewer');
        const record = await writtenExport('csv');

        const res = await request(app)
          .get(url(`/${record.id}/download`))
          .set(bearer(viewer))
          .buffer(true)
          .parse((response, done) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () => {
              done(null, Buffer.concat(chunks));
            });
          });

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
        expect(res.headers['content-disposition']).toBe(
          'attachment; filename="customers-customer-360-pilot-20261123-0930.csv"',
        );
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers['content-length']).toBe(String(CSV.length));
        expect(Buffer.compare(res.body as Buffer, CSV)).toBe(0);
        const page = await repos.audit.listByProject(projectId, { skip: 0, limit: 100 });
        const entry = page.items.find((e) => e.action === 'export.download');
        expect(entry).toMatchObject({
          actorId: viewer.id,
          entityType: 'export',
          entityId: record.id,
        });
        expect(entry?.after).toMatchObject({ format: 'csv', rowCount: 1, bytes: CSV.length });
        expect(JSON.stringify(entry)).not.toContain('+91');
      });

      it('serves an XLSX with the spreadsheet content type', async () => {
        const record = await writtenExport('xlsx');
        const res = await request(app)
          .get(url(`/${record.id}/download`))
          .set(bearer(owner))
          .buffer(true)
          .parse((response, done) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () => {
              done(null, Buffer.concat(chunks));
            });
          })
          .expect(200);
        expect(res.headers['content-type']).toBe(
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        );
        expect(res.headers['content-disposition']).toMatch(
          /filename="customers-[a-z0-9-]+\.xlsx"$/,
        );
        expect((res.body as Buffer).subarray(0, 4).toString('latin1')).toBe('PK\x03\x04');
      });

      it('answers 401, 404 for non-members, unknown exports and a missing file; no audit', async () => {
        const record = await writtenExport();
        const stranger = await register('stranger@example.com');
        await request(app)
          .get(url(`/${record.id}/download`))
          .expect(401);
        await request(app)
          .get(url(`/${record.id}/download`))
          .set(bearer(stranger))
          .expect(404);
        await request(app)
          .get(url(`/${newId()}/download`))
          .set(bearer(owner))
          .expect(404);
        await storage.delete(record.fileKey);
        const gone = await request(app)
          .get(url(`/${record.id}/download`))
          .set(bearer(owner));
        expect(gone.status).toBe(404);
        expect(gone.body.error.message).toContain('no longer available');
        expect(await actions()).not.toContain('export.download');
      });
    });

    describe('DELETE /projects/:projectId/exports/:exportId', () => {
      it('lets a data engineer delete an export and its file; audited', async () => {
        const engineer = await memberWith('data_engineer');
        const record = await writtenExport();

        const res = await request(app)
          .delete(url(`/${record.id}`))
          .set(bearer(engineer));
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ deleted: true });
        expect(await storage.exists(record.fileKey)).toBe(false);
        await request(app)
          .get(url(`/${record.id}`))
          .set(bearer(owner))
          .expect(404);
        await request(app)
          .delete(url(`/${record.id}`))
          .set(bearer(owner))
          .expect(404);
        expect(await actions()).toContain('export.delete');
      });

      it('answers 403 for viewers and data stewards, 404 for non-members, 401 without a token', async () => {
        const record = await writtenExport();
        const viewer = await memberWith('viewer');
        const steward = await memberWith('data_steward');
        const stranger = await register('stranger@example.com');
        for (const session of [viewer, steward]) {
          const res = await request(app)
            .delete(url(`/${record.id}`))
            .set(bearer(session));
          expect(res.status).toBe(403);
        }
        await request(app)
          .delete(url(`/${record.id}`))
          .set(bearer(stranger))
          .expect(404);
        await request(app)
          .delete(url(`/${record.id}`))
          .expect(401);
        await request(app).delete(url('/nope')).set(bearer(owner)).expect(400);
        expect(await storage.exists(record.fileKey)).toBe(true);
      });

      it('deletes every export and file with the project', async () => {
        const record = await writtenExport();
        await request(app).delete(`/api/v1/projects/${projectId}`).set(bearer(owner)).expect(204);
        expect(await storage.exists(record.fileKey)).toBe(false);
        expect(await repos.exports.listByProject(projectId, 10)).toEqual([]);
      });
    });
  });
}
