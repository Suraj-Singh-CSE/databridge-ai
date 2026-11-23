import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import type { KnowledgeSummary } from '../../src/modules/knowledge/knowledge.types.js';
import type { Repositories } from '../../src/repositories.js';

import type { Harness } from './api-suite.js';
import { buildTestApp, fastPasswords } from './build-app.js';
import { FakeAiService } from './fakes.js';

export interface KnowledgeHarness extends Harness {
  /** Stores a summary as the ai-worker's `knowledge_index` job does. */
  workerKnowledgeSummary(repos: Repositories, summary: KnowledgeSummary): Promise<void>;
}

interface Session {
  id: string;
  token: string;
}

type Role = 'viewer' | 'data_steward' | 'data_engineer';

const PASSWORD = 'correct horse battery';
const bearer = (s: Session) => ({ Authorization: `Bearer ${s.token}` });

export function knowledgeSummary(projectId: string): KnowledgeSummary {
  return {
    projectId,
    jobId: 'a'.repeat(24),
    chunkCount: 391,
    chunksByKind: { customer: 67, decision: 7, mapping: 25, quality: 20, sql: 1, docs: 271 },
    droppedByPrivacyGuard: 0,
    maskedDocs: 13,
    mode: 'hybrid',
    embeddingModel: 'gemini-embedding-001',
    embedded: 12,
    reused: 379,
    embeddingError: null,
    finishedAt: new Date('2026-11-23T10:15:00.000Z'),
  };
}

/** GET /projects/:projectId/knowledge/summary and the `knowledge_index` job (ADR 0024). */
export function defineKnowledgeSuite(label: string, harness: KnowledgeHarness): void {
  describe(`Knowledge index API (${label})`, () => {
    let repos: Repositories;
    let app: Express;
    let aiService: FakeAiService;
    let owner: Session;
    let projectId: string;

    async function register(email: string): Promise<Session> {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ email, name: 'User', password: PASSWORD })
        .expect(201);
      const body = res.body as { data: { user: { id: string }; accessToken: string } };
      return { id: body.data.user.id, token: body.data.accessToken };
    }

    async function memberWith(role: Role | null): Promise<Session> {
      const email = `${role ?? 'outsider'}-${Math.random().toString(36).slice(2)}@example.com`;
      await repos.users.create({
        email,
        name: role ?? 'outsider',
        role: 'data_engineer',
        passwordHash: await fastPasswords.hash(PASSWORD),
      });
      const login = await request(app)
        .post('/api/v1/auth/login')
        .send({ email, password: PASSWORD })
        .expect(200);
      if (role) {
        await request(app)
          .post(`/api/v1/projects/${projectId}/members`)
          .set(bearer(owner))
          .send({ email, role })
          .expect(201);
      }
      const body = login.body as { data: { user: { id: string }; accessToken: string } };
      return { id: body.data.user.id, token: body.data.accessToken };
    }

    const summaryUrl = (project = projectId) => `/api/v1/projects/${project}/knowledge/summary`;
    const jobsUrl = () => `/api/v1/projects/${projectId}/jobs`;
    const indexJob = { type: 'knowledge_index', payload: {} };

    beforeEach(async () => {
      repos = await harness.setup();
      aiService = new FakeAiService();
      app = buildTestApp({ repos, aiService });
      await register('first-admin@example.com');
      owner = await register('owner@example.com');
      const res = await request(app)
        .post('/api/v1/projects')
        .set(bearer(owner))
        .send({ name: 'Customer 360' })
        .expect(201);
      projectId = (res.body as { data: { project: { id: string } } }).data.project.id;
    });

    it('returns null before the first index, then the stored summary to any member', async () => {
      const viewer = await memberWith('viewer');
      const empty = await request(app).get(summaryUrl()).set(bearer(viewer));
      expect(empty.status).toBe(200);
      expect(empty.body).toEqual({ data: { summary: null }, error: null });

      await harness.workerKnowledgeSummary(repos, knowledgeSummary(projectId));
      const res = await request(app).get(summaryUrl()).set(bearer(viewer)).expect(200);
      expect(res.body.data.summary).toEqual({
        ...knowledgeSummary(projectId),
        finishedAt: '2026-11-23T10:15:00.000Z',
      });
    });

    it('refuses anonymous users, non-members and invalid ids', async () => {
      await request(app).get(summaryUrl()).expect(401);
      const outsider = await memberWith(null);
      const hidden = await request(app).get(summaryUrl()).set(bearer(outsider));
      expect(hidden.status).toBe(404);
      expect(hidden.body.error.code).toBe('NOT_FOUND');
      const invalid = await request(app).get(summaryUrl('not-an-id')).set(bearer(owner));
      expect(invalid.status).toBe(400);
      expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('lets data engineers start the index job, one at a time', async () => {
      const steward = await memberWith('data_steward');
      const forbidden = await request(app).post(jobsUrl()).set(bearer(steward)).send(indexJob);
      expect(forbidden.status).toBe(403);
      expect(forbidden.body.error.code).toBe('FORBIDDEN');

      const engineer = await memberWith('data_engineer');
      const started = await request(app).post(jobsUrl()).set(bearer(engineer)).send(indexJob);
      expect(started.status).toBe(202);
      expect(started.body.data.job).toMatchObject({ type: 'knowledge_index', status: 'queued' });
      expect(aiService.enqueued.map((e) => e.input.type)).toEqual(['knowledge_index']);

      const busy = await request(app).post(jobsUrl()).set(bearer(owner)).send(indexJob);
      expect(busy.status).toBe(409);
      expect(busy.body.error.code).toBe('CONFLICT');
      expect(busy.body.error.details).toMatchObject({ reason: 'KNOWLEDGE_INDEX_RUNNING' });

      const extra = await request(app)
        .post(jobsUrl())
        .set(bearer(owner))
        .send({ type: 'knowledge_index', payload: { full: true } });
      expect(extra.status).toBe(400);
      expect(extra.body.error.code).toBe('VALIDATION_ERROR');
    });
  });
}
