import { randomBytes } from 'node:crypto';

import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import type {
  ConfidenceLabel,
  MappingRole,
  StoredSuggestion,
} from '../../src/modules/mappings/mapping.types.js';
import { CUSTOMER_360 } from '../../src/modules/target-schema/default-schema.js';
import type { Repositories } from '../../src/repositories.js';

import type { Harness } from './api-suite.js';
import { buildTestApp, fastPasswords } from './build-app.js';
import { FakeAiService } from './fakes.js';
import type { SuggestionWrite } from './memory-repositories.js';

export interface MappingsHarness extends Harness {
  /** Sets the source to `profiled`, as the Python profiler does. */
  markProfiled(repos: Repositories, projectId: string, sourceId: string): Promise<void>;
  /** Writes mapping suggestions directly, as the Python mapping worker does. */
  workerSuggest(repos: Repositories, write: SuggestionWrite): Promise<void>;
}

interface Session {
  id: string;
  token: string;
}

const PASSWORD = 'correct horse battery';
const bearer = (s: Session) => ({ Authorization: `Bearer ${s.token}` });
const newId = () => randomBytes(12).toString('hex');
const RUN_JOB = newId();

export function suggested(
  column: string,
  position: number,
  target: string | null,
  label: ConfidenceLabel = 'High',
  role: MappingRole = target ? 'field' : 'ignore',
  schemaVersion = 1,
): StoredSuggestion {
  const confidence = label === 'High' ? 0.95 : label === 'Medium' ? 0.7 : 0.4;
  return {
    column,
    position,
    suggestion: {
      target,
      role,
      confidence,
      confidenceLabel: label,
      reason: 'The column name matches.',
      transform: target === 'email' ? 'lowercase' : null,
      alternatives: [{ target: null, role: 'ignore', confidence: 0.4 }],
    },
    run: {
      jobId: RUN_JOB,
      runId: `${RUN_JOB}:1`,
      schemaVersion,
      method: 'hybrid',
      model: 'mock',
      createdAt: new Date('2026-11-21T10:00:00Z'),
    },
  };
}

/** Target schema, mapping jobs and review decisions, against memory repositories and MongoDB. */
export function defineMappingsSuite(label: string, harness: MappingsHarness): void {
  describe(`Target schema and mappings API (${label})`, () => {
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

    async function newProject(session: Session, name = 'Customer 360'): Promise<string> {
      const res = await request(app)
        .post('/api/v1/projects')
        .set(bearer(session))
        .send({ name })
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
        rowCount: 10,
        columnCount: 4,
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

    const schemaUrl = (project = projectId) => `/api/v1/projects/${project}/target-schema`;
    const mappingsUrl = (project = projectId, source = sourceId) =>
      `/api/v1/projects/${project}/sources/${source}/mappings`;
    const columnUrl = (column: string, project = projectId, source = sourceId) =>
      `${mappingsUrl(project, source)}/${encodeURIComponent(column)}`;

    /** Four CRM columns as the worker would suggest them. */
    async function suggest(source = sourceId, project = projectId): Promise<void> {
      await harness.workerSuggest(repos, {
        projectId: project,
        sourceId: source,
        suggestions: [
          suggested('mail', 2, 'email', 'High'),
          suggested('cust_id', 0, null, 'High', 'source_record_id'),
          suggested('email_id', 1, 'email', 'Medium'),
          suggested('location', 3, 'city', 'Low'),
        ],
      });
    }

    const fieldsWith = (...extra: object[]) => [
      ...CUSTOMER_360.fields.map(({ name, type, generated }) => ({ name, type, generated })),
      ...extra,
    ];

    beforeEach(async () => {
      repos = await harness.setup();
      ai = new FakeAiService();
      app = buildTestApp({ repos, aiService: ai });
      await register('first-admin@example.com');
      owner = await register('owner@example.com');
      projectId = await newProject(owner);
      sourceId = await addSource();
    });

    describe('GET /projects/:projectId/target-schema', () => {
      it('seeds the Customer 360 schema and shows it to any member', async () => {
        const viewer = await memberWith('viewer');

        const res = await request(app).get(schemaUrl()).set(bearer(viewer));

        expect(res.status).toBe(200);
        expect(res.body.error).toBeNull();
        const schema = (res.body as { data: { schema: { fields: { name: string }[] } } }).data
          .schema;
        expect(schema).toMatchObject({ name: 'Customer 360', version: 1, updatedBy: null });
        expect(schema.fields.map((f) => f.name)).toEqual([
          'customer_id',
          'full_name',
          'phone',
          'email',
          'date_of_birth',
          'city',
          'pin_code',
          'address',
        ]);
        expect(schema.fields[0]).toMatchObject({ generated: true, required: true });
        expect(schema.fields[4]).toMatchObject({ type: 'date', format: 'YYYY-MM-DD', isPii: true });
        // Seeded once: a second read returns the same stored version.
        const again = await request(app).get(schemaUrl()).set(bearer(owner)).expect(200);
        expect(again.body.data.schema.version).toBe(1);
      });

      it('answers 404 to non-members, 400 for a bad id and 401 without a token', async () => {
        const outsider = await register('outsider@example.com');
        const hidden = await request(app).get(schemaUrl()).set(bearer(outsider));
        expect(hidden.status).toBe(404);
        expect(hidden.body.error.code).toBe('NOT_FOUND');
        const bad = await request(app).get(schemaUrl('nope')).set(bearer(owner));
        expect(bad.status).toBe(400);
        expect(bad.body.error.code).toBe('VALIDATION_ERROR');
        const anonymous = await request(app).get(schemaUrl());
        expect(anonymous.status).toBe(401);
        expect(anonymous.body.error.code).toBe('UNAUTHORIZED');
      });
    });

    describe('PUT /projects/:projectId/target-schema', () => {
      const body = (fields: object[] = fieldsWith(), extra: object = {}) => ({
        name: 'Customer 360',
        fields,
        ...extra,
      });

      it('replaces the fields, bumps the version and writes an audit entry', async () => {
        const engineer = await memberWith('data_engineer');
        const fields = fieldsWith({
          name: 'loyalty_tier',
          type: 'string',
          description: 'Gold, Silver or Bronze.',
        });

        const res = await request(app)
          .put(schemaUrl())
          .set(bearer(engineer))
          .send(body(fields, { baseVersion: 1 }));

        expect(res.status).toBe(200);
        expect(res.body.data.schema).toMatchObject({ version: 2, updatedBy: engineer.id });
        expect(res.body.data.schema.fields.at(-1)).toEqual({
          name: 'loyalty_tier',
          type: 'string',
          format: null,
          description: 'Gold, Silver or Bronze.',
          isPii: false,
          generated: false,
          required: false,
          allowConcat: false,
        });
        const read = await request(app).get(schemaUrl()).set(bearer(owner)).expect(200);
        expect(read.body.data.schema.version).toBe(2);
        const audit = await repos.audit.listByProject(projectId, { skip: 0, limit: 10 });
        const entry = audit.items.find((e) => e.action === 'target_schema.replace');
        expect(entry).toMatchObject({
          actorId: engineer.id,
          entityType: 'target_schema',
          before: { version: 1 },
          after: { version: 2 },
        });
        expect((entry?.after as { fields: string[] }).fields).toContain('loyalty_tier');
      });

      it('answers 409 when baseVersion is not the current version', async () => {
        await request(app).put(schemaUrl()).set(bearer(owner)).send(body()).expect(200);

        const stale = await request(app)
          .put(schemaUrl())
          .set(bearer(owner))
          .send(body(fieldsWith(), { baseVersion: 1 }));

        expect(stale.status).toBe(409);
        expect(stale.body.error.code).toBe('CONFLICT');
      });

      it('validates names, types, duplicates and the field count', async () => {
        const cases: [object, string][] = [
          [body([{ name: 'Full Name', type: 'string' }]), 'body.fields.0.name'],
          [body([{ name: 'email', type: 'money' }]), 'body.fields.0.type'],
          [
            body([
              { name: 'email', type: 'string' },
              { name: 'email', type: 'string' },
            ]),
            'body.fields.1.name',
          ],
          [
            body(Array.from({ length: 101 }, (_, i) => ({ name: `f_${i}`, type: 'string' }))),
            'body.fields',
          ],
          [body([{ name: 'customer_id', type: 'string', generated: true }]), 'body.fields'],
          [body([]), 'body.fields'],
          [body(fieldsWith(), { ownerId: owner.id }), 'body'],
          [{ fields: fieldsWith() }, 'body.name'],
        ];
        for (const [payload, field] of cases) {
          const res = await request(app).put(schemaUrl()).set(bearer(owner)).send(payload);
          expect(res.status).toBe(400);
          expect(res.body.error.code).toBe('VALIDATION_ERROR');
          expect((res.body.error.details as { field: string }[]).map((d) => d.field)).toContain(
            field,
          );
        }
      });

      it('is for data engineers and admins: stewards and viewers 403, outsiders 404', async () => {
        const steward = await memberWith('data_steward');
        const viewer = await memberWith('viewer');
        const outsider = await register('outsider@example.com');

        for (const session of [steward, viewer]) {
          const res = await request(app).put(schemaUrl()).set(bearer(session)).send(body());
          expect(res.status).toBe(403);
          expect(res.body.error.code).toBe('FORBIDDEN');
        }
        expect(
          (await request(app).put(schemaUrl()).set(bearer(outsider)).send(body())).status,
        ).toBe(404);
        expect((await request(app).put(schemaUrl()).send(body())).status).toBe(401);
      });
    });

    describe('POST /projects/:projectId/jobs with type "mapping"', () => {
      const mapping = (source: string) => ({ type: 'mapping', payload: { sourceId: source } });
      const post = (payload: object, session: Session = owner) =>
        request(app).post(`/api/v1/projects/${projectId}/jobs`).set(bearer(session)).send(payload);

      it('needs a profiled source (409 otherwise) and stores the target schema first', async () => {
        const early = await post(mapping(sourceId));
        expect(early.status).toBe(409);
        expect(early.body.error.message).toMatch(/Profile this source first/);
        expect(await repos.targetSchemas.findByProject(projectId)).toBeNull();

        await harness.markProfiled(repos, projectId, sourceId);
        const res = await post(mapping(sourceId));

        expect(res.status).toBe(202);
        expect(res.body.data.job).toMatchObject({ type: 'mapping', payload: { sourceId } });
        expect(ai.enqueued.map((e) => e.input.type)).toEqual(['mapping']);
        expect((await repos.targetSchemas.findByProject(projectId))?.version).toBe(1);
      });

      it('answers 409 while another mapping job works on the source, 404 for others', async () => {
        await harness.markProfiled(repos, projectId, sourceId);
        await post(mapping(sourceId)).expect(202);

        const busy = await post(mapping(sourceId));
        expect(busy.status).toBe(409);
        expect(busy.body.error.message).toMatch(/already being made/);
        // A profile job of the same source is a different type and is not blocked.
        expect((await post({ type: 'profile', payload: { sourceId } })).status).toBe(202);
        expect((await post(mapping(newId()))).status).toBe(404);
      });

      it('validates the payload and checks roles', async () => {
        await harness.markProfiled(repos, projectId, sourceId);
        const invalid = await post({ type: 'mapping', payload: { sourceId: 'x' } });
        expect(invalid.status).toBe(400);
        expect((invalid.body.error.details as { field: string }[])[0]?.field).toBe(
          'body.payload.sourceId',
        );
        const steward = await memberWith('data_steward');
        expect((await post(mapping(sourceId), steward)).status).toBe(403);
      });
    });

    describe('GET .../sources/:sourceId/mappings', () => {
      it('is empty before the first mapping job', async () => {
        const res = await request(app).get(mappingsUrl()).set(bearer(owner));

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({
          source: { id: sourceId, name: 'CRM', status: 'uploaded' },
          schemaVersion: 1,
          run: null,
          stale: false,
          columns: [],
          summary: { total: 0, high: 0, medium: 0, low: 0, decided: 0 },
        });
      });

      it('returns suggestions in file order with their decision and status', async () => {
        await suggest();
        await request(app)
          .patch(columnUrl('mail'))
          .set(bearer(owner))
          .send({ decision: 'accept' })
          .expect(200);
        const viewer = await memberWith('viewer');

        const res = await request(app).get(mappingsUrl()).set(bearer(viewer));

        expect(res.status).toBe(200);
        const data = (
          res.body as { data: Record<string, unknown> & { columns: { column: string }[] } }
        ).data;
        expect(data.columns.map((c) => c.column)).toEqual([
          'cust_id',
          'email_id',
          'mail',
          'location',
        ]);
        expect(data.run).toMatchObject({
          jobId: RUN_JOB,
          schemaVersion: 1,
          method: 'hybrid',
          model: 'mock',
        });
        expect(data.stale).toBe(false);
        expect(data.summary).toEqual({ total: 4, high: 2, medium: 1, low: 1, decided: 1 });
        expect(data.columns[2]).toMatchObject({
          column: 'mail',
          status: 'accepted',
          suggestion: { target: 'email', confidenceLabel: 'High', transform: 'lowercase' },
          decision: { decision: 'accept', target: 'email', role: 'field', decidedBy: owner.id },
        });
        expect(data.columns[0]).toMatchObject({ status: 'pending', decision: null });
      });

      it('marks suggestions stale after the target schema changes', async () => {
        await suggest();
        await request(app)
          .put(schemaUrl())
          .set(bearer(owner))
          .send({ name: 'Customer 360', fields: fieldsWith() })
          .expect(200);

        const res = await request(app).get(mappingsUrl()).set(bearer(owner)).expect(200);
        expect(res.body.data).toMatchObject({ schemaVersion: 2, stale: true });
      });

      it('answers 404 to non-members and for unknown or foreign sources', async () => {
        const outsider = await register('outsider@example.com');
        const other = await newProject(outsider, 'Other');
        const foreign = await addSource(other);

        expect((await request(app).get(mappingsUrl()).set(bearer(outsider))).status).toBe(404);
        expect(
          (await request(app).get(mappingsUrl(projectId, newId())).set(bearer(owner))).status,
        ).toBe(404);
        expect(
          (await request(app).get(mappingsUrl(projectId, foreign)).set(bearer(owner))).status,
        ).toBe(404);
        expect(
          (await request(app).get(mappingsUrl(projectId, 'x')).set(bearer(owner))).status,
        ).toBe(400);
        expect((await request(app).get(mappingsUrl())).status).toBe(401);
      });
    });

    describe('PATCH .../mappings/:column', () => {
      beforeEach(async () => {
        await suggest();
      });

      const patch = (column: string, body: object, session: Session = owner) =>
        request(app).patch(columnUrl(column)).set(bearer(session)).send(body);

      it('accepts, rejects and overrides, recording who decided and an audit entry', async () => {
        const steward = await memberWith('data_steward');

        const accepted = await patch('cust_id', { decision: 'accept' }, steward);
        expect(accepted.status).toBe(200);
        expect(accepted.body.data.column).toMatchObject({
          column: 'cust_id',
          status: 'accepted',
          decision: {
            decision: 'accept',
            target: null,
            role: 'source_record_id',
            transform: null,
            schemaVersion: 1,
            decidedBy: steward.id,
          },
        });
        expect(typeof accepted.body.data.column.decision.decidedAt).toBe('string');

        const rejected = await patch('location', { decision: 'reject' }, steward);
        expect(rejected.body.data.column).toMatchObject({
          status: 'rejected',
          decision: { target: null, role: 'ignore' },
        });

        const overridden = await patch('email_id', {
          decision: 'override',
          role: 'field',
          target: 'email',
          transform: 'lowercase',
        });
        expect(overridden.status).toBe(200);
        expect(overridden.body.data.column).toMatchObject({
          status: 'overridden',
          decision: { decision: 'override', target: 'email', transform: 'lowercase' },
        });

        const audit = await repos.audit.listByProject(projectId, { skip: 0, limit: 20 });
        const decisions = audit.items.filter((e) => e.action === 'mapping.decide');
        expect(decisions).toHaveLength(3);
        expect(
          decisions.find((e) => e.actorId === steward.id && e.after?.column === 'cust_id'),
        ).toMatchObject({
          entityType: 'mapping',
          entityId: `${sourceId}:cust_id`,
          after: { sourceId, decision: 'accept', role: 'source_record_id' },
        });
      });

      it('answers 409 when another column is already accepted onto the same field', async () => {
        await patch('mail', { decision: 'accept' }).expect(200);

        const second = await patch('email_id', { decision: 'accept' });
        expect(second.status).toBe(409);
        expect(second.body.error.code).toBe('CONFLICT');
        expect(second.body.error.message).toMatch(/"mail" is already mapped to "email"/);
        const override = await patch('location', {
          decision: 'override',
          role: 'field',
          target: 'email',
        });
        expect(override.status).toBe(409);

        // Fields that allow concatenation take several columns.
        await patch('email_id', {
          decision: 'override',
          role: 'field',
          target: 'address',
        }).expect(200);
        await patch('location', {
          decision: 'override',
          role: 'field',
          target: 'address',
        }).expect(200);
        // Changing the holder frees the field.
        await patch('mail', { decision: 'reject' }).expect(200);
        await patch('cust_id', { decision: 'override', role: 'field', target: 'email' }).expect(
          200,
        );
      });

      it('validates the decision, target, role and transform', async () => {
        const cases: [object, string][] = [
          [{ decision: 'maybe' }, 'body.decision'],
          [{ decision: 'override', role: 'field' }, 'body.target'],
          [{ decision: 'override', role: 'ignore', target: 'email' }, 'body.target'],
          [
            { decision: 'override', role: 'field', target: 'email', transform: 'rm -rf' },
            'body.transform',
          ],
          [{ decision: 'override', role: 'owner', target: null }, 'body.role'],
          [{ decision: 'accept', target: 'email' }, 'body'],
          [{ decision: 'override', role: 'field', target: 'nickname' }, 'body.target'],
          [{ decision: 'override', role: 'field', target: 'customer_id' }, 'body.target'],
        ];
        for (const [body, field] of cases) {
          const res = await patch('mail', body);
          expect(res.status).toBe(400);
          expect(res.body.error.code).toBe('VALIDATION_ERROR');
          expect((res.body.error.details as { field: string }[]).map((d) => d.field)).toContain(
            field,
          );
        }
        const long = await request(app)
          .patch(columnUrl('x'.repeat(201)))
          .set(bearer(owner))
          .send({ decision: 'accept' });
        expect(long.status).toBe(400);
      });

      it('answers 409 for a suggestion whose field left the schema', async () => {
        await request(app)
          .put(schemaUrl())
          .set(bearer(owner))
          .send({ name: 'Slim', fields: [{ name: 'full_name', type: 'string' }] })
          .expect(200);

        const res = await patch('mail', { decision: 'accept' });
        expect(res.status).toBe(409);
        expect(res.body.error.message).toMatch(/no longer in the target schema/);
      });

      it('answers 404 for unknown columns and sources, 403 to viewers, 404 to outsiders, 401 anonymous', async () => {
        const viewer = await memberWith('viewer');
        const outsider = await register('outsider@example.com');

        expect((await patch('nope', { decision: 'accept' })).status).toBe(404);
        expect(
          (
            await request(app)
              .patch(columnUrl('mail', projectId, newId()))
              .set(bearer(owner))
              .send({ decision: 'accept' })
          ).status,
        ).toBe(404);
        const forbidden = await patch('mail', { decision: 'accept' }, viewer);
        expect(forbidden.status).toBe(403);
        expect(forbidden.body.error.code).toBe('FORBIDDEN');
        expect((await patch('mail', { decision: 'accept' }, outsider)).status).toBe(404);
        expect(
          (await request(app).patch(columnUrl('mail')).send({ decision: 'accept' })).status,
        ).toBe(401);
      });
    });

    describe('POST .../mappings/accept-high', () => {
      const acceptHigh = (session: Session = owner) =>
        request(app).post(`${mappingsUrl()}/accept-high`).set(bearer(session));

      it('accepts undecided High suggestions and reports what it skipped', async () => {
        await harness.workerSuggest(repos, {
          projectId,
          sourceId,
          suggestions: [
            suggested('cust_id', 0, null, 'High', 'source_record_id'),
            suggested('email_id', 1, 'email', 'High'),
            suggested('mail', 2, 'email', 'High'),
            suggested('city', 3, 'city', 'High'),
            suggested('ph', 4, 'phone', 'Medium'),
          ],
        });
        await request(app)
          .patch(columnUrl('city'))
          .set(bearer(owner))
          .send({ decision: 'reject' })
          .expect(200);
        const steward = await memberWith('data_steward');

        const res = await acceptHigh(steward);

        expect(res.status).toBe(200);
        // cust_id and email_id accepted; mail conflicts on email; city was decided already.
        expect(res.body.data).toEqual({ accepted: 2, alreadyDecided: 1, conflicts: 1 });
        const list = await request(app).get(mappingsUrl()).set(bearer(owner)).expect(200);
        const statuses = (list.body.data.columns as { column: string; status: string }[]).map(
          (c) => [c.column, c.status],
        );
        expect(statuses).toEqual([
          ['cust_id', 'accepted'],
          ['email_id', 'accepted'],
          ['mail', 'pending'],
          ['city', 'rejected'],
          ['ph', 'pending'],
        ]);
        const audit = await repos.audit.listByProject(projectId, { skip: 0, limit: 20 });
        expect(audit.items.find((e) => e.action === 'mapping.accept_high')).toMatchObject({
          actorId: steward.id,
          after: { sourceId, accepted: 2, alreadyDecided: 1, conflicts: 1 },
        });

        // Running it again changes nothing.
        expect((await acceptHigh()).body.data).toEqual({
          accepted: 0,
          alreadyDecided: 3,
          conflicts: 1,
        });
      });

      it('skips suggestions whose field left the schema', async () => {
        await suggest();
        await request(app)
          .put(schemaUrl())
          .set(bearer(owner))
          .send({ name: 'Slim', fields: [{ name: 'city', type: 'string' }] })
          .expect(200);

        expect((await acceptHigh()).body.data).toEqual({
          accepted: 1,
          alreadyDecided: 0,
          conflicts: 1,
        });
      });

      it('needs review access: viewers 403, outsiders 404, anonymous 401', async () => {
        await suggest();
        const viewer = await memberWith('viewer');
        const outsider = await register('outsider@example.com');

        expect((await acceptHigh(viewer)).status).toBe(403);
        expect((await acceptHigh(outsider)).status).toBe(404);
        expect((await request(app).post(`${mappingsUrl()}/accept-high`)).status).toBe(401);
        const bad = await request(app)
          .post(`${mappingsUrl(projectId, 'x')}/accept-high`)
          .set(bearer(owner));
        expect(bad.status).toBe(400);
      });
    });

    it('deletes suggestions and decisions with their source, and the schema with the project', async () => {
      await suggest();
      await request(app)
        .patch(columnUrl('mail'))
        .set(bearer(owner))
        .send({ decision: 'accept' })
        .expect(200);
      const kept = await addSource();
      await suggest(kept);

      await request(app)
        .delete(`/api/v1/projects/${projectId}/sources/${sourceId}`)
        .set(bearer(owner))
        .expect(204);
      expect(await repos.mappings.listSuggestions(projectId, sourceId)).toEqual([]);
      expect(await repos.mappings.listDecisions(projectId, sourceId)).toEqual([]);
      expect(await repos.mappings.listSuggestions(projectId, kept)).toHaveLength(4);

      await request(app).delete(`/api/v1/projects/${projectId}`).set(bearer(owner)).expect(204);
      expect(await repos.mappings.listSuggestions(projectId, kept)).toEqual([]);
      expect(await repos.targetSchemas.findByProject(projectId)).toBeNull();
    });
  });
}
