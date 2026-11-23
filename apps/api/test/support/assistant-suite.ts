import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import type { LlmCall } from '../../src/modules/dashboard/dashboard.types.js';
import type { KnowledgeSummary } from '../../src/modules/knowledge/knowledge.types.js';
import type { Repositories } from '../../src/repositories.js';

import type { Harness } from './api-suite.js';
import { buildTestApp, fastPasswords } from './build-app.js';
import { FakeAiService } from './fakes.js';
import { knowledgeSummary } from './knowledge-suite.js';

export interface AssistantHarness extends Harness {
  workerKnowledgeSummary(repos: Repositories, summary: KnowledgeSummary): Promise<void>;
  workerLlmCall(repos: Repositories, call: LlmCall): Promise<void>;
}

interface Session {
  id: string;
  token: string;
}

type Role = 'viewer' | 'data_steward' | 'data_engineer';

const PASSWORD = 'correct horse battery';
const bearer = (s: Session) => ({ Authorization: `Bearer ${s.token}` });
const QUESTION = 'Why did PIN completeness fail?';
const PERSONAL = 'Is asha.rao@example.com a duplicate?';

function llmCall(projectId: string, task: string): LlmCall {
  return {
    projectId,
    task,
    model: 'mock',
    inputTokens: 1200,
    outputTokens: 60,
    costInr: 0.01,
    latencyMs: 40,
    cacheHit: false,
    outcome: 'ok',
    errorType: null,
    errorCode: null,
    errorStatus: null,
    schemaFallback: false,
    createdAt: new Date(),
  };
}

/** /projects/:projectId/assistant (ADR 0025), memory and MongoDB. */
export function defineAssistantSuite(label: string, harness: AssistantHarness): void {
  describe(`Assistant API (${label})`, () => {
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

    const base = (project = projectId) => `/api/v1/projects/${project}/assistant`;
    const ask = (session: Session, body: object) =>
      request(app).post(`${base()}/ask`).set(bearer(session)).send(body);

    async function setup(env: NodeJS.ProcessEnv = {}): Promise<void> {
      repos = await harness.setup();
      aiService = new FakeAiService();
      app = buildTestApp({ repos, aiService, env });
      await register('first-admin@example.com');
      owner = await register('owner@example.com');
      const res = await request(app)
        .post('/api/v1/projects')
        .set(bearer(owner))
        .send({ name: 'Customer 360' })
        .expect(201);
      projectId = (res.body as { data: { project: { id: string } } }).data.project.id;
    }

    beforeEach(async () => {
      await setup();
      await harness.workerKnowledgeSummary(repos, knowledgeSummary(projectId));
    });

    it('answers a member with citations and keeps the conversation', async () => {
      const viewer = await memberWith('viewer');
      const first = await ask(viewer, { question: `  ${QUESTION}  ` });
      expect(first.status).toBe(200);
      const { conversationId, turn } = first.body.data as {
        conversationId: string;
        turn: { answer: string; citations: unknown[] };
      };
      expect(turn).toMatchObject({
        question: QUESTION,
        answerable: true,
        confidence: 'high',
        refusalReason: null,
        mode: 'hybrid',
      });
      expect(turn.citations[0]).toMatchObject({ n: 1, kind: 'quality' });
      expect(aiService.asked[0]?.input).toEqual({ projectId, question: QUESTION, history: [] });

      const second = await ask(viewer, { question: 'And the email?', conversationId });
      expect(second.body.data.conversationId).toBe(conversationId);
      expect(aiService.asked[1]?.input.history).toEqual([
        { question: QUESTION, answer: turn.answer },
      ]);

      const list = await request(app).get(`${base()}/conversations`).set(bearer(viewer));
      expect(list.status).toBe(200);
      const items = (list.body as { data: { items: unknown[] } }).data.items;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        id: conversationId,
        title: QUESTION,
        turnCount: 2,
      });
      const one = await request(app)
        .get(`${base()}/conversations/${conversationId}`)
        .set(bearer(viewer));
      expect(one.status).toBe(200);
      expect(one.body.data.conversation.turns.map((t: { question: string }) => t.question)).toEqual(
        [QUESTION, 'And the email?'],
      );
    });

    it('never stores a question the guard refused for personal data', async () => {
      aiService.answer = () => ({
        answer: 'Please ask without customer details — use a customer ID instead.',
        citations: [],
        confidence: 'low',
        answerable: false,
        refusalReason: 'personal_data',
        mode: null,
        model: null,
        latencyMs: 2,
        redactions: 0,
        invalidCitations: 0,
      });
      const res = await ask(owner, { question: PERSONAL });
      expect(res.status).toBe(200);
      expect(res.body.data.turn).toMatchObject({ question: null, refusalReason: 'personal_data' });
      const id = res.body.data.conversationId as string;
      const stored = await request(app).get(`${base()}/conversations/${id}`).set(bearer(owner));
      expect(stored.body.data.conversation.title).toBe('Conversation');
      expect(JSON.stringify(stored.body)).not.toContain('asha');
    });

    it('validates the question and the ids', async () => {
      for (const body of [
        {},
        { question: '   ' },
        { question: 'x'.repeat(501) },
        { question: 'Q', extra: 1 },
        { question: 'Q', conversationId: 'nope' },
      ]) {
        const res = await ask(owner, body);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
      const badProject = await request(app)
        .post(`${base('not-an-id')}/ask`)
        .set(bearer(owner))
        .send({ question: QUESTION });
      expect(badProject.status).toBe(400);
      expect(aiService.asked).toHaveLength(0);
    });

    it('refuses anonymous users and hides the project from non-members', async () => {
      await request(app).post(`${base()}/ask`).send({ question: QUESTION }).expect(401);
      await request(app).get(`${base()}/conversations`).expect(401);
      await request(app).get(`${base()}/usage`).expect(401);
      const outsider = await memberWith(null);
      const hidden = await ask(outsider, { question: QUESTION });
      expect(hidden.status).toBe(404);
      expect(hidden.body.error.code).toBe('NOT_FOUND');
      await request(app).get(`${base()}/conversations`).set(bearer(outsider)).expect(404);
    });

    it('shows and deletes conversations only to their owner, and audits deletes', async () => {
      const res = await ask(owner, { question: QUESTION });
      const id = res.body.data.conversationId as string;
      const engineer = await memberWith('data_engineer');
      const other = await request(app).get(`${base()}/conversations/${id}`).set(bearer(engineer));
      expect(other.status).toBe(404);
      await request(app).delete(`${base()}/conversations/${id}`).set(bearer(engineer)).expect(404);
      const continued = await ask(engineer, { question: QUESTION, conversationId: id });
      expect(continued.status).toBe(404);
      const theirs = await request(app).get(`${base()}/conversations`).set(bearer(engineer));
      expect(theirs.body.data.items).toEqual([]);

      const deleted = await request(app).delete(`${base()}/conversations/${id}`).set(bearer(owner));
      expect(deleted.status).toBe(200);
      expect(deleted.body.data).toEqual({ deleted: true });
      await request(app).get(`${base()}/conversations/${id}`).set(bearer(owner)).expect(404);
      const audit = await repos.audit.listByProject(projectId, { skip: 0, limit: 50 });
      const entry = audit.items.find((e) => e.action === 'assistant_conversation.delete');
      expect(entry).toMatchObject({ entityId: id, before: { turnCount: 1 } });
      // Questions themselves are not audited.
      expect(audit.items.some((e) => e.action.startsWith('assistant.'))).toBe(false);
    });

    it('answers 409 before the knowledge index exists', async () => {
      await setup();
      const res = await ask(owner, { question: QUESTION });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({
        code: 'KNOWLEDGE_NOT_BUILT',
        message: 'Build the project knowledge index first.',
      });
      expect(aiService.asked).toHaveLength(0);
      // The ai-service may also find the index empty.
      await harness.workerKnowledgeSummary(repos, knowledgeSummary(projectId));
      aiService.askError = { status: 409, code: 'KNOWLEDGE_NOT_BUILT' };
      const empty = await ask(owner, { question: QUESTION });
      expect(empty.status).toBe(409);
      expect(empty.body.error.code).toBe('KNOWLEDGE_NOT_BUILT');
    });

    it('answers 503 when the ai-service is unavailable, storing nothing', async () => {
      aiService.down = true;
      const res = await ask(owner, { question: QUESTION });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('AI_SERVICE_UNAVAILABLE');
      aiService.down = false;
      aiService.askError = { status: 503, code: 'LLM_UNAVAILABLE' };
      expect((await ask(owner, { question: QUESTION })).status).toBe(503);
      const list = await request(app).get(`${base()}/conversations`).set(bearer(owner));
      expect(list.body.data.items).toEqual([]);
    });

    it('limits questions per user', async () => {
      await setup({ ASSISTANT_RATE_LIMIT_MAX: '2' });
      await harness.workerKnowledgeSummary(repos, knowledgeSummary(projectId));
      await ask(owner, { question: QUESTION }).expect(200);
      await ask(owner, { question: QUESTION }).expect(200);
      const limited = await ask(owner, { question: QUESTION });
      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe('RATE_LIMITED');
      const viewer = await memberWith('viewer');
      await ask(viewer, { question: QUESTION }).expect(200);
    });

    it('reports usage counts to data engineers only', async () => {
      await ask(owner, { question: QUESTION }).expect(200);
      aiService.answer = () => ({
        answer: "I don't have enough information in this project to answer that.",
        citations: [],
        confidence: 'low',
        answerable: false,
        refusalReason: 'weak_retrieval',
        mode: 'hybrid',
        model: null,
        latencyMs: 4,
        redactions: 0,
        invalidCitations: 0,
      });
      await ask(owner, { question: 'What is the weather?' }).expect(200);
      await harness.workerLlmCall(repos, llmCall(projectId, 'assistant'));
      await harness.workerLlmCall(repos, llmCall(projectId, 'embedding'));

      const steward = await memberWith('data_steward');
      const forbidden = await request(app).get(`${base()}/usage`).set(bearer(steward));
      expect(forbidden.status).toBe(403);
      expect(forbidden.body.error.code).toBe('FORBIDDEN');

      const engineer = await memberWith('data_engineer');
      const res = await request(app).get(`${base()}/usage`).set(bearer(engineer));
      expect(res.status).toBe(200);
      expect(res.body.data.usage).toEqual({
        conversations: 2,
        users: 1,
        questions: 2,
        answered: 1,
        refusals: { personal_data: 0, weak_retrieval: 1, not_answerable: 0, no_citation: 0 },
        avgLatencyMs: 8,
        model: {
          calls: 1,
          ok: 1,
          inputTokens: 1200,
          outputTokens: 60,
          costInr: 0.01,
          models: ['mock'],
        },
      });
      expect(JSON.stringify(res.body)).not.toContain('weather');
    });

    it('deletes the conversations with the project', async () => {
      await ask(owner, { question: QUESTION }).expect(200);
      await request(app).delete(`/api/v1/projects/${projectId}`).set(bearer(owner)).expect(204);
      expect((await repos.assistant.usage(projectId)).conversations).toBe(0);
    });
  });
}
