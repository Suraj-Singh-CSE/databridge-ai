import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Repositories } from '../../src/repositories.js';
import type { LocalDiskStorage } from '../../src/storage/local-disk.storage.js';
import type { FileStorage } from '../../src/storage/storage.types.js';

import type { Harness } from './api-suite.js';
import { buildTestApp, fastPasswords, tempStorage } from './build-app.js';

const SAMPLES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../eval/samples',
);
const CRM_CSV = readFileSync(path.join(SAMPLES, 'crm_customers.csv'));
const BILLING_XLSX = readFileSync(path.join(SAMPLES, 'billing_export.xlsx'));
const PASSWORD = 'correct horse battery';

interface Session {
  id: string;
  token: string;
}

const bearer = (s: Session) => ({ Authorization: `Bearer ${s.token}` });
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** Every file under the storage root, as relative paths. */
async function storedFiles(storage: LocalDiskStorage): Promise<string[]> {
  const entries = await readdir(storage.root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(storage.root, path.join(entry.parentPath, entry.name)))
    .sort();
}

/** Polls `check` every 10 ms until it returns true (fails after `ms`). */
async function eventually(check: () => Promise<boolean>, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A small CSV whose content (and so sha256) is unique per `tag`. */
function csv(tag: string, rows = 2): Buffer {
  const lines = ['id,name,city'];
  for (let i = 1; i <= rows; i += 1) lines.push(`${i},${tag} ${i},Pune`);
  return Buffer.from(lines.join('\n') + '\n');
}

/**
 * The HTTP contract of source uploads, run against in-memory repositories and real MongoDB,
 * always with real local-disk storage in a temp directory so stored files can be inspected.
 */
export function defineSourcesSuite(label: string, harness: Harness): void {
  describe(`Sources API (${label})`, () => {
    let repos: Repositories;
    let storage: LocalDiskStorage;
    let app: Express;
    let owner: Session;
    let projectId: string;

    function appWith(
      env: NodeJS.ProcessEnv = {},
      overrides: { repos?: Repositories; storage?: FileStorage } = {},
    ): Express {
      return buildTestApp({
        repos: overrides.repos ?? repos,
        storage: overrides.storage ?? storage,
        env,
      });
    }

    async function register(email: string): Promise<Session> {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ email, name: 'User', password: PASSWORD })
        .expect(201);
      const body = res.body as { data: { user: { id: string }; accessToken: string } };
      return { id: body.data.user.id, token: body.data.accessToken };
    }

    async function memberWith(role: 'viewer' | 'data_steward' | 'data_engineer'): Promise<Session> {
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

    async function newProject(session: Session, name = 'Customer 360'): Promise<string> {
      const res = await request(app)
        .post('/api/v1/projects')
        .set(bearer(session))
        .send({ name })
        .expect(201);
      return (res.body as { data: { project: { id: string } } }).data.project.id;
    }

    const sourcesUrl = (id = projectId) => `/api/v1/projects/${id}/sources`;

    function upload(
      file: Buffer | null,
      filename: string,
      options: {
        target?: Express;
        session?: Session;
        project?: string;
        fields?: Record<string, string>;
        contentType?: string;
      } = {},
    ) {
      let req = request(options.target ?? app)
        .post(sourcesUrl(options.project))
        .set(bearer(options.session ?? owner));
      for (const [name, value] of Object.entries(options.fields ?? {})) {
        req = req.field(name, value);
      }
      if (file) {
        req = req.attach('file', file, {
          filename,
          contentType: options.contentType ?? 'application/octet-stream',
        });
      }
      return req;
    }

    async function uploaded(file: Buffer, filename: string, fields: Record<string, string> = {}) {
      const res = await upload(file, filename, { fields }).expect(201);
      return (res.body as { data: { source: { id: string } & Record<string, unknown> } }).data
        .source;
    }

    beforeEach(async () => {
      repos = await harness.setup();
      storage = tempStorage();
      app = appWith();
      await register('first-admin@example.com');
      owner = await register('owner@example.com');
      projectId = await newProject(owner);
    });

    describe('POST /projects/:projectId/sources', () => {
      it('streams a CSV to storage and records its metadata', async () => {
        const res = await upload(CRM_CSV, 'crm_customers.csv', {
          fields: { name: ' CRM customers ', systemName: 'CRM' },
          contentType: 'text/csv',
        });

        expect(res.status).toBe(201);
        const source = res.body.data.source as Record<string, unknown> & { id: string };
        expect(source).toMatchObject({
          projectId,
          name: 'CRM customers',
          systemName: 'CRM',
          originalFilename: 'crm_customers.csv',
          format: 'csv',
          sizeBytes: CRM_CSV.length,
          sha256: sha256(CRM_CSV),
          status: 'uploaded',
          rowCount: 143,
          columnCount: 10,
          error: null,
          uploadedBy: owner.id,
        });
        expect(source.fileKey).toBeUndefined();

        const key = `projects/${projectId}/sources/${source.id}/original.csv`;
        expect(await storedFiles(storage)).toEqual([key]);
        expect(await readFile(path.join(storage.root, key))).toEqual(CRM_CSV);
      });

      it('accepts an XLSX workbook and leaves row counts to the profiler', async () => {
        const source = await uploaded(BILLING_XLSX, 'billing_export.xlsx');

        expect(source).toMatchObject({
          name: 'billing_export',
          systemName: null,
          format: 'xlsx',
          sizeBytes: BILLING_XLSX.length,
          rowCount: null,
          columnCount: null,
        });
        expect(await storedFiles(storage)).toEqual([
          `projects/${projectId}/sources/${source.id}/original.xlsx`,
        ]);
      });

      it('never uses the client filename for the storage key and sanitises it for display', async () => {
        const source = await uploaded(csv('evil'), '../../etc/\u202Epasswd\u200B .csv', {
          systemName: '   ',
        });

        expect(source.originalFilename).toBe('passwd .csv');
        expect(source.systemName).toBeNull();
        expect(await storedFiles(storage)).toEqual([
          `projects/${projectId}/sources/${source.id}/original.csv`,
        ]);
      });

      it('counts CSV rows with a real parser (quoted newlines, BOM, blank lines)', async () => {
        const file = Buffer.from(
          '﻿id,note\n1,"line one\nline two"\n2,"a ""quoted"" value, with comma"\n\n3,"x\r\ny\r\nz"\n',
        );
        const source = await uploaded(file, 'notes.csv');

        expect(source).toMatchObject({ rowCount: 3, columnCount: 2 });
      });

      it('lets a project admin upload; viewers and stewards cannot', async () => {
        const viewer = await memberWith('viewer');
        const steward = await memberWith('data_steward');
        const engineer = await memberWith('data_engineer');

        for (const session of [viewer, steward]) {
          const res = await upload(csv('x'), 'x.csv', { session });
          expect(res.status).toBe(403);
          expect(res.body.error.code).toBe('FORBIDDEN');
        }
        await upload(csv('engineer'), 'e.csv', { session: engineer }).expect(201);
        expect(await storedFiles(storage)).toHaveLength(1);
      });

      it('hides the project from outsiders and requires authentication', async () => {
        const outsider = await register('outsider@example.com');

        await upload(csv('x'), 'x.csv', { session: outsider }).expect(404);
        await request(app).post(sourcesUrl()).attach('file', csv('x'), 'x.csv').expect(401);
        await upload(csv('x'), 'x.csv', { project: 'not-an-id' }).expect(400);
        expect(await storedFiles(storage)).toEqual([]);
      });

      it.each([
        ['program.exe'],
        ['legacy.xls'],
        ['macros.xlsm'],
        ['data.csv.exe'],
        ['README'],
        ['data.json'],
      ])('rejects %s by extension', async (filename) => {
        const res = await upload(csv('x'), filename);

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('UNSUPPORTED_FILE');
        expect(res.body.error.message).toMatch(/Only \.csv and \.xlsx/);
        expect(await storedFiles(storage)).toEqual([]);
      });

      it('accepts upper-case extensions', async () => {
        await upload(csv('upper'), 'EXPORT.CSV').expect(201);
      });

      it('sniffs content instead of trusting the extension or Content-Type', async () => {
        const fakeXlsx = await upload(Buffer.from('id,name\n1,a\n'), 'fake.xlsx', {
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });
        const tinyXlsx = await upload(Buffer.from('PK'), 'tiny.xlsx');
        const binaryCsv = await upload(Buffer.from([0x69, 0x64, 0x0a, 0x00, 0x01, 0x0a]), 'b.csv', {
          contentType: 'text/csv',
        });
        const zipAsCsv = await upload(BILLING_XLSX, 'renamed.csv');

        for (const res of [fakeXlsx, tinyXlsx, binaryCsv, zipAsCsv]) {
          expect(res.status).toBe(400);
          expect(res.body.error.code).toBe('UNSUPPORTED_FILE');
        }
        expect(fakeXlsx.body.error.message).toMatch(/not a real Excel workbook/);
        expect(await storedFiles(storage)).toEqual([]);
      });

      it('rejects a CSV that is not UTF-8', async () => {
        const latin1 = Buffer.from('id,name\n1,Jos\xe9\n', 'latin1');
        const res = await upload(latin1, 'latin1.csv');

        expect(res.status).toBe(400);
        expect(res.body.error).toMatchObject({ code: 'UNSUPPORTED_FILE' });
        expect(res.body.error.message).toMatch(/not UTF-8/);
        expect(await storedFiles(storage)).toEqual([]);
      });

      it('rejects empty files, CSVs without a header line and malformed CSVs', async () => {
        const empty = await upload(Buffer.alloc(0), 'empty.csv');
        const emptyXlsx = await upload(Buffer.alloc(0), 'empty.xlsx');
        const blank = await upload(Buffer.from('﻿\n\n\r\n'), 'blank.csv');
        const broken = await upload(Buffer.from('id,name\n1,"never closed\n2,b\n'), 'broken.csv');

        expect(empty.body.error).toMatchObject({
          code: 'UNSUPPORTED_FILE',
          message: 'The file is empty.',
        });
        expect(emptyXlsx.body.error.message).toBe('The file is empty.');
        expect(blank.body.error.message).toMatch(/no header line/);
        expect(broken.status).toBe(400);
        expect(broken.body.error.message).toMatch(/could not be read/);
        expect(broken.body.error.message).not.toMatch(/never closed/);
        expect(await storedFiles(storage)).toEqual([]);
      });

      it('enforces MAX_UPLOAD_BYTES with a friendly 413 and keeps nothing', async () => {
        const small = appWith({ MAX_UPLOAD_BYTES: '1024' });
        const big = Buffer.from('id,value\n' + '1,xxxxxxxxxxxxxxxxxxxx\n'.repeat(200));

        const tooBig = await upload(big, 'big.csv', { target: small });
        expect(tooBig.status).toBe(413);
        expect(tooBig.body.error).toMatchObject({
          code: 'PAYLOAD_TOO_LARGE',
          message: expect.stringMatching(/larger than the 1 KB limit/) as unknown,
        });
        expect(await storedFiles(storage)).toEqual([]);

        await upload(csv('fits'), 'fits.csv', { target: small }).expect(201);
      });

      it('enforces MAX_UPLOAD_ROWS for CSV (data rows, header excluded) and deletes the file', async () => {
        const limited = appWith({ MAX_UPLOAD_ROWS: '5' });

        await upload(csv('five', 5), 'five.csv', { target: limited }).expect(201);
        const six = await upload(csv('six', 6), 'six.csv', { target: limited });
        expect(six.status).toBe(413);
        expect(six.body.error.code).toBe('TOO_MANY_ROWS');
        expect(six.body.error.message).toMatch(/more than 5 data rows/);
        expect(await storedFiles(storage)).toHaveLength(1);
      });

      it('rejects the same file twice in one project with 409 and deletes the duplicate', async () => {
        await uploaded(csv('dup'), 'first.csv');
        const again = await upload(csv('dup'), 'second-name.csv');

        expect(again.status).toBe(409);
        expect(again.body.error).toMatchObject({
          code: 'CONFLICT',
          message: 'This file is already in the project.',
        });
        expect(await storedFiles(storage)).toHaveLength(1);

        const other = await newProject(owner, 'Other');
        await upload(csv('dup'), 'first.csv', { project: other }).expect(201);
      });

      it('caps sources per project with 409 LIMIT_REACHED', async () => {
        const capped = appWith({ MAX_SOURCES_PER_PROJECT: '2' });
        await upload(csv('a'), 'a.csv', { target: capped }).expect(201);
        await upload(csv('b'), 'b.csv', { target: capped }).expect(201);

        const third = await upload(csv('c'), 'c.csv', { target: capped });
        expect(third.status).toBe(409);
        expect(third.body.error.code).toBe('LIMIT_REACHED');
        expect(await storedFiles(storage)).toHaveLength(2);
      });

      it('validates the form fields and removes the stored file on failure', async () => {
        const longName = await upload(csv('n'), 'n.csv', { fields: { name: 'x'.repeat(81) } });
        const longSystem = await upload(csv('n'), 'n.csv', {
          fields: { systemName: 'y'.repeat(41) },
        });
        const unknown = await upload(csv('n'), 'n.csv', { fields: { owner: 'me' } });

        expect(longName.status).toBe(400);
        expect(longName.body.error.details).toEqual([
          { field: 'body.name', message: 'must be at most 80 characters' },
        ]);
        expect(longSystem.body.error.details[0].field).toBe('body.systemName');
        expect(unknown.body.error.details[0].field).toBe('body.owner');
        expect(await storedFiles(storage)).toEqual([]);
      });

      it('requires exactly one multipart file named "file"', async () => {
        const missing = await upload(null, '', { fields: { name: 'No file' } });
        const json = await request(app).post(sourcesUrl()).set(bearer(owner)).send({ name: 'x' });
        const wrongField = await request(app)
          .post(sourcesUrl())
          .set(bearer(owner))
          .attach('upload', csv('w'), 'w.csv');
        const asText = await request(app)
          .post(sourcesUrl())
          .set(bearer(owner))
          .field('file', 'id,name\n1,a\n');
        const two = await request(app)
          .post(sourcesUrl())
          .set(bearer(owner))
          .attach('file', csv('one'), 'one.csv')
          .attach('file', csv('two'), 'two.csv');

        expect(missing.status).toBe(400);
        expect(missing.body.error.details).toEqual([
          { field: 'body.file', message: 'is required' },
        ]);
        expect(json.status).toBe(400);
        expect(json.body.error.message).toMatch(/multipart\/form-data/);
        expect(wrongField.status).toBe(400);
        expect(asText.body.error.details).toEqual([
          { field: 'body.file', message: 'must be a file' },
        ]);
        expect(two.status).toBe(400);
        expect(two.body.error.message).toBe('Upload one file per request.');
        expect(await storedFiles(storage)).toEqual([]);
      });

      it('leaves no file and no record when saving the record fails', async () => {
        const failing: Repositories = {
          ...repos,
          sources: {
            ...repos.sources,
            create: () => Promise.reject(new Error('database down')),
          },
        };
        const res = await upload(csv('fail'), 'fail.csv', {
          target: appWith({}, { repos: failing }),
        });

        expect(res.status).toBe(500);
        expect(res.body.error.code).toBe('INTERNAL_ERROR');
        expect(await storedFiles(storage)).toEqual([]);
        expect(await repos.sources.countByProject(projectId)).toBe(0);
      });

      it('rolls back the record and the file when the audit write fails', async () => {
        const failing: Repositories = {
          ...repos,
          audit: { ...repos.audit, append: () => Promise.reject(new Error('audit down')) },
        };
        const res = await upload(csv('audit'), 'audit.csv', {
          target: appWith({}, { repos: failing }),
        });

        expect(res.status).toBe(500);
        expect(await storedFiles(storage)).toEqual([]);
        expect(await repos.sources.countByProject(projectId)).toBe(0);
      });

      it('leaves nothing behind when storage fails mid-write', async () => {
        const broken: FileStorage = {
          put: async (key, body) => {
            await storage.put(key, body, { contentType: 'text/csv' });
            await storage.delete(key);
            throw new Error('disk full');
          },
          getStream: (key) => storage.getStream(key),
          delete: (key) => storage.delete(key),
          deletePrefix: (prefix) => storage.deletePrefix(prefix),
          exists: (key) => storage.exists(key),
        };
        const res = await upload(csv('disk'), 'disk.csv', {
          target: appWith({}, { storage: broken }),
        });

        expect(res.status).toBe(500);
        expect(await storedFiles(storage)).toEqual([]);
        expect(await repos.sources.countByProject(projectId)).toBe(0);
      });

      it('removes the partial file when the client disconnects mid-upload', async () => {
        const server = app.listen(0);
        try {
          const { port } = server.address() as AddressInfo;
          const boundary = 'DataBridgeBoundary';
          const req = http.request({
            port,
            method: 'POST',
            path: sourcesUrl(),
            headers: {
              ...bearer(owner),
              'Content-Type': `multipart/form-data; boundary=${boundary}`,
              'Content-Length': String(10 * 1024 * 1024),
            },
          });
          req.on('error', () => undefined);
          req.write(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.csv"\r\n` +
              `Content-Type: text/csv\r\n\r\nid,name\n${'1,abc\n'.repeat(20_000)}`,
          );
          await eventually(async () => (await storedFiles(storage)).length > 0);
          req.destroy();

          await eventually(async () => (await storedFiles(storage)).length === 0);
          expect(await repos.sources.countByProject(projectId)).toBe(0);
        } finally {
          server.close();
        }
      });

      it('rate-limits uploads per user', async () => {
        const limited = appWith({ UPLOAD_RATE_LIMIT_MAX: '2' });
        await upload(csv('r1'), 'r1.csv', { target: limited }).expect(201);
        await upload(csv('r2'), 'r2.csv', { target: limited }).expect(201);

        const third = await upload(csv('r3'), 'r3.csv', { target: limited });
        expect(third.status).toBe(429);
        expect(third.body.error.code).toBe('RATE_LIMITED');

        const engineer = await memberWith('data_engineer');
        await upload(csv('r4'), 'r4.csv', { target: limited, session: engineer }).expect(201);
      });

      it('audits the upload with metadata only', async () => {
        const source = await uploaded(CRM_CSV, 'crm.csv', { systemName: 'CRM' });

        const { items } = await repos.audit.listByProject(projectId, { skip: 0, limit: 10 });
        const entry = items.find((e) => e.action === 'source.upload');
        expect(entry).toMatchObject({
          actorId: owner.id,
          entityType: 'source',
          entityId: source.id,
          after: { name: 'crm', systemName: 'CRM', format: 'csv', rowCount: 143, columnCount: 10 },
        });
        expect(JSON.stringify(entry)).not.toMatch(/Rudra|example\.net|6376476497/);
      });
    });

    describe('GET /projects/:projectId/sources', () => {
      it('lists the project sources newest first to any member', async () => {
        await uploaded(csv('one'), 'one.csv');
        await uploaded(csv('two'), 'two.csv');
        const other = await newProject(owner, 'Other');
        await upload(csv('elsewhere'), 'x.csv', { project: other }).expect(201);
        const viewer = await memberWith('viewer');

        const res = await request(app).get(sourcesUrl()).set(bearer(viewer));

        expect(res.status).toBe(200);
        const items = res.body.data.items as { name: string; fileKey?: string }[];
        expect(items.map((s) => s.name)).toEqual(['two', 'one']);
        expect(items[0]?.fileKey).toBeUndefined();
      });

      it('hides the list from outsiders and requires authentication', async () => {
        const outsider = await register('outsider@example.com');
        await request(app).get(sourcesUrl()).set(bearer(outsider)).expect(404);
        await request(app).get(sourcesUrl()).expect(401);
        await request(app).get(sourcesUrl('123')).set(bearer(owner)).expect(400);
      });
    });

    describe('GET /projects/:projectId/sources/:sourceId', () => {
      it('returns one source to members; 404 for a source of another project', async () => {
        const source = await uploaded(csv('one'), 'one.csv');
        const other = await newProject(owner, 'Other');
        const steward = await memberWith('data_steward');

        const res = await request(app).get(`${sourcesUrl()}/${source.id}`).set(bearer(steward));
        expect(res.status).toBe(200);
        expect(res.body.data.source).toMatchObject({ id: source.id, name: 'one' });

        const wrongProject = await request(app)
          .get(`${sourcesUrl(other)}/${source.id}`)
          .set(bearer(owner));
        expect(wrongProject.status).toBe(404);
        expect(wrongProject.body.error.message).toBe('Source not found.');
      });

      it('validates ids and requires authentication', async () => {
        const res = await request(app).get(`${sourcesUrl()}/nope`).set(bearer(owner));
        expect(res.status).toBe(400);
        expect(res.body.error.details[0].field).toBe('params.sourceId');
        await request(app).get(`${sourcesUrl()}/0123456789abcdef01234567`).expect(401);
      });
    });

    describe('PATCH /projects/:projectId/sources/:sourceId', () => {
      it('renames a source and sets or clears its system name', async () => {
        const source = await uploaded(csv('one'), 'one.csv', { systemName: 'CRM' });
        const url = `${sourcesUrl()}/${source.id}`;

        const renamed = await request(app)
          .patch(url)
          .set(bearer(owner))
          .send({ name: ' Customers ', systemName: 'Salesforce' });
        expect(renamed.status).toBe(200);
        expect(renamed.body.data.source).toMatchObject({
          name: 'Customers',
          systemName: 'Salesforce',
        });

        const cleared = await request(app).patch(url).set(bearer(owner)).send({ systemName: null });
        expect(cleared.body.data.source).toMatchObject({ name: 'Customers', systemName: null });

        const { items } = await repos.audit.listByProject(projectId, { skip: 0, limit: 10 });
        expect(items[1]).toMatchObject({
          action: 'source.update',
          before: { name: 'one', systemName: 'CRM' },
          after: { name: 'Customers', systemName: 'Salesforce' },
        });
      });

      it('validates the body', async () => {
        const source = await uploaded(csv('one'), 'one.csv');
        const url = `${sourcesUrl()}/${source.id}`;

        await request(app).patch(url).set(bearer(owner)).send({}).expect(400);
        await request(app).patch(url).set(bearer(owner)).send({ name: '' }).expect(400);
        await request(app)
          .patch(url)
          .set(bearer(owner))
          .send({ status: 'ready', fileKey: '../x' })
          .expect(400);
      });

      it('is limited to data_engineer members and above', async () => {
        const source = await uploaded(csv('one'), 'one.csv');
        const url = `${sourcesUrl()}/${source.id}`;
        const viewer = await memberWith('viewer');
        const outsider = await register('outsider@example.com');

        await request(app).patch(url).set(bearer(viewer)).send({ name: 'x' }).expect(403);
        await request(app).patch(url).set(bearer(outsider)).send({ name: 'x' }).expect(404);
        await request(app).patch(url).send({ name: 'x' }).expect(401);
        await request(app)
          .patch(`${sourcesUrl()}/0123456789abcdef01234567`)
          .set(bearer(owner))
          .send({ name: 'x' })
          .expect(404);
      });
    });

    describe('DELETE /projects/:projectId/sources/:sourceId', () => {
      it('deletes the record and the stored file, and audits it', async () => {
        const keep = await uploaded(csv('keep'), 'keep.csv');
        const drop = await uploaded(csv('drop'), 'drop.csv');

        await request(app).delete(`${sourcesUrl()}/${drop.id}`).set(bearer(owner)).expect(204);

        await request(app).get(`${sourcesUrl()}/${drop.id}`).set(bearer(owner)).expect(404);
        expect(await storedFiles(storage)).toEqual([
          `projects/${projectId}/sources/${keep.id}/original.csv`,
        ]);
        const { items } = await repos.audit.listByProject(projectId, { skip: 0, limit: 1 });
        expect(items[0]).toMatchObject({
          action: 'source.delete',
          entityId: drop.id,
          before: { name: 'drop' },
        });
        await request(app).delete(`${sourcesUrl()}/${drop.id}`).set(bearer(owner)).expect(404);
      });

      it('is limited to data_engineer members and above', async () => {
        const source = await uploaded(csv('one'), 'one.csv');
        const url = `${sourcesUrl()}/${source.id}`;
        const steward = await memberWith('data_steward');

        await request(app).delete(url).set(bearer(steward)).expect(403);
        await request(app).delete(url).expect(401);
        expect(await storedFiles(storage)).toHaveLength(1);
      });
    });

    describe('GET /projects/:projectId/sources/:sourceId/preview', () => {
      it('returns the header and the first rows of a CSV (default 20)', async () => {
        const source = await uploaded(CRM_CSV, 'crm.csv');
        const viewer = await memberWith('viewer');

        const res = await request(app)
          .get(`${sourcesUrl()}/${source.id}/preview`)
          .set(bearer(viewer));

        expect(res.status).toBe(200);
        expect(res.body.data.columns).toEqual([
          'cust_id',
          'cust_nm',
          'ph',
          'email_id',
          'dob',
          'gender',
          'addr',
          'city',
          'pin',
          'created_on',
        ]);
        expect(res.body.data.rows).toHaveLength(20);
        expect(res.body.data.rows[0][0]).toBe('C000001');
        expect(res.body.data.rows[0][6]).toBe('34/906, Zachariah Chowk');
      });

      it('previews the first worksheet of an XLSX', async () => {
        const source = await uploaded(BILLING_XLSX, 'billing.xlsx');

        const res = await request(app)
          .get(`${sourcesUrl()}/${source.id}/preview?limit=3`)
          .set(bearer(owner));

        expect(res.status).toBe(200);
        expect(res.body.data.columns.slice(0, 3)).toEqual([
          'CustomerID',
          'CustomerName',
          'mobile_no',
        ]);
        expect(res.body.data.rows).toHaveLength(3);
        expect(res.body.data.rows[0][0]).toBe('BL-0000001');
        expect(res.body.data.rows[0][8]).toBe('4954');
      });

      it('caps columns at 50 and cells at 200 characters, and honours the limit', async () => {
        const header = Array.from({ length: 60 }, (_, i) => `c${i}`).join(',');
        const long = 'é'.repeat(300);
        const rows = Array.from({ length: 5 }, (_, i) => `${long},${i}`).join('\n');
        const source = await uploaded(Buffer.from(`${header}\n${rows}\n`), 'wide.csv');

        const res = await request(app)
          .get(`${sourcesUrl()}/${source.id}/preview?limit=2`)
          .set(bearer(owner));

        expect(res.body.data.columns).toHaveLength(50);
        expect(res.body.data.rows).toHaveLength(2);
        const cell = res.body.data.rows[0][0] as string;
        expect(Array.from(cell)).toHaveLength(200);
        expect(cell.endsWith('…')).toBe(true);
        expect(res.body.data.rows[1].slice(0, 3)).toEqual([cell, '1', '']);
      });

      it('validates the limit (1-50)', async () => {
        const source = await uploaded(csv('one'), 'one.csv');
        const url = `${sourcesUrl()}/${source.id}/preview`;

        await request(app).get(`${url}?limit=51`).set(bearer(owner)).expect(400);
        await request(app).get(`${url}?limit=0`).set(bearer(owner)).expect(400);
        const max = await request(app).get(`${url}?limit=50`).set(bearer(owner)).expect(200);
        expect(max.body.data.rows).toHaveLength(2);
      });

      it('answers 404 when the stored file is missing, and hides it from outsiders', async () => {
        const source = await uploaded(csv('gone'), 'gone.csv');
        const url = `${sourcesUrl()}/${source.id}/preview`;
        const outsider = await register('outsider@example.com');

        await request(app).get(url).set(bearer(outsider)).expect(404);
        await request(app).get(url).expect(401);
        await storage.deletePrefix(`projects/${projectId}/`);
        const res = await request(app).get(url).set(bearer(owner));
        expect(res.status).toBe(404);
        expect(res.body.error.message).toMatch(/file for this source is missing/);
      });
    });

    describe('project deletion', () => {
      it('deletes the project sources and its storage prefix, nothing else', async () => {
        await uploaded(csv('one'), 'one.csv');
        await uploaded(BILLING_XLSX, 'billing.xlsx');
        const other = await newProject(owner, 'Other');
        const kept = await upload(csv('kept'), 'kept.csv', { project: other }).expect(201);
        const keptId = (kept.body as { data: { source: { id: string } } }).data.source.id;

        await request(app).delete(`/api/v1/projects/${projectId}`).set(bearer(owner)).expect(204);

        expect(await repos.sources.countByProject(projectId)).toBe(0);
        expect(await storedFiles(storage)).toEqual([
          `projects/${other}/sources/${keptId}/original.csv`,
        ]);
        expect(await repos.sources.countByProject(other)).toBe(1);
      });
    });
  });
}
