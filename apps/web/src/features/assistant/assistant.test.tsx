import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import type {
  AssistantConversation,
  AssistantConversationSummary,
  AssistantRefusalReason,
  AssistantTurn,
  KnowledgeSummary,
  ProjectRole,
} from '@/lib/api-types';
import {
  API,
  fail,
  jobFrame,
  makeJob,
  makeProject,
  makeSession,
  ok,
  signedInHandlers,
  sseChannel,
} from '@/test/fixtures';
import { renderApp } from '@/test/render-app';
import { server } from '@/test/server';

import { REFUSAL_TEXT, citationTarget, splitAnswer } from './assistant-labels';

const PROJECT_ID = '64b0000000000000000000a1';
const PATH = `/projects/${PROJECT_ID}/assistant`;
const USER_ID = '64b000000000000000000001';
const CONVERSATION_ID = '64b0000000000000000000c1';
const SOURCE_ID = '64b0000000000000000000b1';

const SUMMARY: KnowledgeSummary = {
  projectId: PROJECT_ID,
  jobId: '64b0000000000000000000d9',
  chunkCount: 412,
  chunksByKind: { customer: 300, decision: 40, mapping: 30, quality: 20, sql: 2, docs: 20 },
  droppedByPrivacyGuard: 0,
  maskedDocs: 1,
  mode: 'hybrid',
  embeddingModel: 'text-embedding',
  embedded: 412,
  reused: 0,
  embeddingError: null,
  finishedAt: new Date(Date.now() - 3_600_000).toISOString(),
};

function makeTurn(overrides: Partial<AssistantTurn> = {}): AssistantTurn {
  return {
    question: 'Why did PIN completeness fail?',
    answer:
      'PIN completeness was 91%, below the 95% threshold [1]. The PIN column maps to pin [2].',
    citations: [
      {
        n: 1,
        chunkId: 'quality:1',
        kind: 'quality',
        title: 'Quality run: completeness of pin',
        link: { page: 'quality', params: { runId: 'r1', rule: 'completeness:pin' } },
      },
      {
        n: 2,
        chunkId: 'mapping:1',
        kind: 'mapping',
        title: 'Mapping of billing_export.csv',
        link: { page: 'mapping', params: { sourceId: SOURCE_ID } },
      },
    ],
    confidence: 'high',
    answerable: true,
    refusalReason: null,
    mode: 'hybrid',
    model: 'mock',
    latencyMs: 120,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function refusal(reason: AssistantRefusalReason, question: string | null = 'What is the weather?') {
  return makeTurn({
    question,
    answer: 'I cannot answer that from the project sources.',
    citations: [],
    confidence: 'low',
    answerable: false,
    refusalReason: reason,
  });
}

const HISTORY: AssistantConversationSummary[] = [
  {
    id: CONVERSATION_ID,
    projectId: PROJECT_ID,
    userId: USER_ID,
    title: 'Who approved the SQL?',
    turnCount: 1,
    createdAt: new Date(Date.now() - 7_200_000).toISOString(),
    updatedAt: new Date(Date.now() - 7_200_000).toISOString(),
  },
];

interface Setup {
  member?: ProjectRole;
  summary?: KnowledgeSummary | null;
  history?: AssistantConversationSummary[];
}

function setup({ member, summary = SUMMARY, history = [] }: Setup = {}) {
  const project = makeProject({
    currentStep: 'quality',
    ownerId: member ? '64b000000000000000000009' : USER_ID,
    members: member ? [{ userId: USER_ID, role: member }] : [],
  });
  server.use(
    ...signedInHandlers(makeSession(member ?? 'data_engineer')),
    http.get(`${API}/projects/:id`, () => ok({ project })),
    http.get(`${API}/projects/:id/knowledge/summary`, () => ok({ summary })),
    http.get(`${API}/projects/:id/assistant/conversations`, () => ok({ items: history })),
    http.get(`${API}/projects/:id/jobs`, () => ok({ items: [] })),
  );
  return renderApp(PATH);
}

/** Answers every question with `turns` in order and records the request bodies. */
function answering(...turns: AssistantTurn[]) {
  const bodies: unknown[] = [];
  server.use(
    http.post(`${API}/projects/:id/assistant/ask`, async ({ request }) => {
      bodies.push(await request.json());
      const turn = turns[Math.min(bodies.length - 1, turns.length - 1)] ?? makeTurn();
      return ok({ conversationId: CONVERSATION_ID, turn });
    }),
  );
  return bodies;
}

async function questionBox() {
  return screen.findByRole('textbox', { name: 'Ask a question about this project' });
}

describe('assistant: helpers', () => {
  it('splits answers into text and known citation markers only', () => {
    expect(splitAnswer('A [1]. B [1, 2]. C [9].', new Set([1, 2]))).toEqual([
      { kind: 'text', text: 'A ' },
      { kind: 'cite', n: 1 },
      { kind: 'text', text: '. B ' },
      { kind: 'cite', n: 1 },
      { kind: 'cite', n: 2 },
      { kind: 'text', text: '. C [9].' },
    ]);
    expect(splitAnswer('<b>x</b>', new Set())).toEqual([{ kind: 'text', text: '<b>x</b>' }]);
  });

  it('maps citation pages to in-app links, docs and unknown pages to text only', () => {
    const cite = (page: string, params: Record<string, string> = {}) => ({
      n: 1,
      chunkId: 'c',
      kind: 'decision' as const,
      title: 't',
      link: { page, params },
    });
    expect(citationTarget('p1', cite('matching', { customerId: 'C1' }))).toEqual({
      to: '/projects/p1/matching',
      label: 'Matching',
    });
    expect(citationTarget('p1', cite('mapping', { sourceId: 's1' }))?.to).toBe(
      '/projects/p1/mapping?source=s1',
    );
    expect(citationTarget('p1', cite('pipeline', { versionId: 'v' }))?.to).toBe(
      '/projects/p1/pipeline',
    );
    expect(citationTarget('p1', cite('docs', { path: 'docs/adr/x.md' }))).toBeNull();
    expect(citationTarget('p1', cite('elsewhere'))).toBeNull();
  });
});

describe('assistant: asking', () => {
  it('sends the question with Enter, shows the answer with linked markers and sources', async () => {
    const bodies = answering(makeTurn());
    setup();
    const user = userEvent.setup();
    const box = await questionBox();
    await user.type(box, 'Why did PIN completeness fail?');
    expect(screen.getByText('30 / 500')).toBeInTheDocument();
    expect(box).toHaveAttribute('maxLength', '500');
    expect(box).toHaveAccessibleDescription(
      /Don't type customer details — use a customer ID instead\./,
    );
    await user.keyboard('{Enter}');

    const answer = await screen.findByRole('article', { name: 'Question and answer' });
    expect(answer.closest('[aria-live="polite"]')).not.toBeNull();
    expect(bodies).toEqual([{ question: 'Why did PIN completeness fail?' }]);
    expect(box).toHaveFocus();
    expect(box).toHaveValue('');
    expect(within(answer).getByText('High confidence')).toBeInTheDocument();
    expect(within(answer).getByRole('link', { name: 'Source 1' })).toHaveAttribute(
      'href',
      '#turn-0-source-1',
    );
    expect(within(answer).getByRole('link', { name: 'Source 2' })).toHaveAttribute(
      'href',
      '#turn-0-source-2',
    );
    const sources = within(answer).getByRole('list', { name: 'Sources' });
    const items = within(sources).getAllByRole('listitem');
    expect(items[0]).toHaveAttribute('id', 'turn-0-source-1');
    expect(within(sources).getByText('Quality')).toBeInTheDocument();
    expect(within(sources).getByText('Mapping of billing_export.csv')).toBeInTheDocument();
    expect(
      within(sources).getByRole('link', { name: 'Open source 1 in Data quality' }),
    ).toHaveAttribute('href', `/projects/${PROJECT_ID}/quality`);
    expect(within(sources).getByRole('link', { name: 'Open source 2 in Mapping' })).toHaveAttribute(
      'href',
      `/projects/${PROJECT_ID}/mapping?source=${SOURCE_ID}`,
    );
  });

  it('continues the same conversation and shows customer and doc sources', async () => {
    const bodies = answering(
      makeTurn(),
      makeTurn({
        question: 'Why were these merged?',
        answer: 'They share a phone and a name [1]. Matching rules are in the design [2].',
        confidence: 'medium',
        citations: [
          {
            n: 1,
            chunkId: 'customer:1',
            kind: 'customer',
            title: 'Customer C3F9A1B2C4D5E',
            link: { page: 'matching', params: { customerId: 'C3F9A1B2C4D5E' } },
          },
          {
            n: 2,
            chunkId: 'docs:1',
            kind: 'docs',
            title: 'ADR 0013 — Entity resolution',
            link: { page: 'docs', params: { path: 'docs/adr/0013.md', section: 'scoring' } },
          },
        ],
      }),
    );
    setup();
    const user = userEvent.setup();
    const box = await questionBox();
    await user.type(box, 'First{Enter}');
    await screen.findByText('High confidence');
    await user.type(box, 'Why were these merged?{Enter}');
    expect(await screen.findByText('Medium confidence')).toBeInTheDocument();
    expect(bodies[1]).toEqual({
      question: 'Why were these merged?',
      conversationId: CONVERSATION_ID,
    });
    const second = screen.getAllByRole('article', { name: 'Question and answer' })[1];
    if (!second) throw new Error('missing');
    expect(within(second).getByRole('link', { name: 'Open source 1 in Matching' })).toHaveAttribute(
      'href',
      `/projects/${PROJECT_ID}/matching`,
    );
    expect(within(second).getByText('Design doc')).toBeInTheDocument();
    expect(within(second).getByText('ADR 0013 — Entity resolution')).toBeInTheDocument();
    expect(within(second).getByText('· section scoring')).toBeInTheDocument();
    expect(within(second).queryByRole('link', { name: /Open source 2/ })).not.toBeInTheDocument();
  });

  it('adds a new line with Shift+Enter without sending', async () => {
    const bodies = answering(makeTurn());
    setup();
    const user = userEvent.setup();
    const box = await questionBox();
    await user.type(box, 'Line one{Shift>}{Enter}{/Shift}Line two');
    expect(box).toHaveValue('Line one\nLine two');
    expect(bodies).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('High confidence');
    expect(bodies).toEqual([{ question: 'Line one\nLine two' }]);
  });

  it('asks an example question with one click and shows the loading state', async () => {
    const bodies: unknown[] = [];
    setup();
    server.use(
      http.post(`${API}/projects/:id/assistant/ask`, async ({ request }) => {
        bodies.push(await request.json());
        await delay(50);
        return ok({
          conversationId: CONVERSATION_ID,
          turn: makeTurn({ question: 'How are duplicates found?' }),
        });
      }),
    );
    const user = userEvent.setup();
    await questionBox();
    expect(screen.getByText(/Don't type customer details/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'How are duplicates found?' }));
    expect(await screen.findByText('Searching project knowledge…')).toBeInTheDocument();
    await screen.findByText('High confidence');
    expect(bodies).toEqual([{ question: 'How are duplicates found?' }]);
  });

  it.each(['weak_retrieval', 'not_answerable', 'no_citation'] as const)(
    'shows a friendly message for the %s refusal',
    async (reason) => {
      answering(refusal(reason));
      setup();
      const user = userEvent.setup();
      await user.type(await questionBox(), 'What is the weather?{Enter}');
      expect(await screen.findByText(REFUSAL_TEXT[reason])).toBeInTheDocument();
      expect(screen.getByText("Couldn't answer this one")).toBeInTheDocument();
      expect(screen.queryByText('Low confidence')).not.toBeInTheDocument();
    },
  );

  it('asks for a customer id when the question held personal details', async () => {
    answering(refusal('personal_data', null));
    setup();
    const user = userEvent.setup();
    await user.type(await questionBox(), 'Why was asha@example.com merged?{Enter}');
    expect(
      await screen.findByText("I can't use customer details. Ask with a customer ID instead."),
    ).toBeInTheDocument();
    expect(screen.getByText('Question hidden (it held customer details)')).toBeInTheDocument();
  });

  it.each([
    [429, 'RATE_LIMITED', 'Too many questions — wait a minute, then ask again.'],
    [
      503,
      'AI_SERVICE_UNAVAILABLE',
      'The assistant is not available right now. Please try again in a few minutes.',
    ],
    [
      409,
      'KNOWLEDGE_NOT_BUILT',
      'The project knowledge has not been built yet, so there is nothing to search.',
    ],
  ])('explains a %i answer and keeps the question', async (status, code, text) => {
    server.use(
      http.post(`${API}/projects/:id/assistant/ask`, () => fail(status, code, 'api message')),
    );
    setup();
    const user = userEvent.setup();
    const box = await questionBox();
    await user.type(box, 'How are duplicates found?{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(box).toHaveValue('How are duplicates found?');
    expect(box).toHaveFocus();
  });

  it('explains a network failure', async () => {
    server.use(http.post(`${API}/projects/:id/assistant/ask`, () => HttpResponse.error()));
    setup();
    const user = userEvent.setup();
    await user.type(await questionBox(), 'How are duplicates found?{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We could not reach the server. Check your connection and try again.',
    );
  });
});

describe('assistant: knowledge', () => {
  it('shows when the knowledge was built, its kinds and the search mode', async () => {
    setup({ member: 'viewer' });
    const section = (await screen.findByRole('heading', { name: 'Project knowledge' })).closest(
      'section',
    );
    if (!section) throw new Error('missing');
    expect(await within(section).findByText('Smart search')).toBeInTheDocument();
    expect(within(section).getByText(/412 pieces of knowledge/)).toBeInTheDocument();
    expect(
      within(within(section).getByRole('list', { name: 'Knowledge by kind' }))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Customer: 300',
      'Decision: 40',
      'Mapping: 30',
      'Quality: 20',
      'SQL: 2',
      'Design doc: 20',
    ]);
    expect(within(section).queryByRole('button', { name: /knowledge/ })).not.toBeInTheDocument();
    // Viewers may ask.
    expect(await questionBox()).toBeEnabled();
  });

  it('asks viewers to find an engineer when the knowledge is not built', async () => {
    setup({ member: 'viewer', summary: null });
    expect(
      await screen.findByText('Ask an engineer to build the project knowledge.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Build knowledge' })).not.toBeInTheDocument();
    expect(await questionBox()).toBeDisabled();
  });

  it('builds the knowledge with live progress and refreshes the summary', async () => {
    const events = sseChannel();
    let body: unknown = null;
    let built = false;
    let summaryReads = 0;
    setup({ member: 'data_engineer', summary: null });
    server.use(
      http.post(`${API}/projects/:id/jobs`, async ({ request }) => {
        body = await request.json();
        return ok(
          {
            job: makeJob({ type: 'knowledge_index', status: 'queued', progress: 0, payload: {} }),
          },
          202,
        );
      }),
      http.get(`${API}/jobs/:id/events`, () => events.response()),
      http.get(`${API}/projects/:id/knowledge/summary`, () => {
        summaryReads += 1;
        return ok({ summary: built ? SUMMARY : null });
      }),
    );
    const user = userEvent.setup();
    const button = await screen.findByRole('button', { name: 'Build knowledge' });
    expect(
      screen.queryByText('Ask an engineer to build the project knowledge.'),
    ).not.toBeInTheDocument();
    await user.click(button);
    await waitFor(() => {
      expect(body).toEqual({ type: 'knowledge_index', payload: {} });
    });
    events.send(jobFrame({ status: 'running', progress: 40, message: 'Embedding' }));
    expect(await screen.findByText('40% done')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Build knowledge' })).toBeInTheDocument();

    built = true;
    const before = summaryReads;
    events.send(jobFrame({ status: 'succeeded', progress: 100 }));
    events.close();
    expect(await screen.findByText('The project knowledge is up to date.')).toBeInTheDocument();
    expect(await screen.findByText('Smart search')).toBeInTheDocument();
    expect(summaryReads).toBeGreaterThan(before);
    expect(screen.getByRole('button', { name: 'Rebuild knowledge' })).toBeInTheDocument();
    expect(await questionBox()).toBeEnabled();
  });
});

describe('assistant: history', () => {
  it('lists, opens and deletes conversations, and starts a new one', async () => {
    const conversation: AssistantConversation = {
      id: CONVERSATION_ID,
      projectId: PROJECT_ID,
      userId: USER_ID,
      title: 'Who approved the SQL?',
      createdAt: HISTORY[0]?.createdAt ?? '',
      updatedAt: HISTORY[0]?.updatedAt ?? '',
      turns: [
        makeTurn({ question: 'Who approved the SQL?', confidence: 'medium' }),
        refusal('weak_retrieval', 'And the weather?'),
      ],
    };
    let deleted = false;
    setup({ history: HISTORY });
    server.use(
      http.get(`${API}/projects/:id/assistant/conversations/:cid`, () => ok({ conversation })),
      http.get(`${API}/projects/:id/assistant/conversations`, () =>
        ok({ items: deleted ? [] : HISTORY }),
      ),
      http.delete(`${API}/projects/:id/assistant/conversations/:cid`, ({ params }) => {
        deleted = params.cid === CONVERSATION_ID;
        return ok({ deleted: true });
      }),
    );
    const user = userEvent.setup();
    const list = await screen.findByRole('list', { name: 'Your conversations' });
    await user.click(
      within(list).getByRole('button', { name: 'Open conversation: Who approved the SQL?' }),
    );
    const turns = await screen.findAllByRole('article', { name: 'Question and answer' });
    expect(turns).toHaveLength(2);
    expect(
      within(turns[0] ?? document.body).getByText('Who approved the SQL?'),
    ).toBeInTheDocument();
    expect(within(turns[1] ?? document.body).getByText(REFUSAL_TEXT.weak_retrieval)).toBeVisible();
    expect(
      within(list).getByRole('button', { name: 'Open conversation: Who approved the SQL?' }),
    ).toHaveAttribute('aria-current', 'true');

    await user.click(
      within(list).getByRole('button', { name: 'Delete conversation: Who approved the SQL?' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Delete this conversation?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete conversation' }));
    expect(await screen.findByText('Your questions will appear here.')).toBeInTheDocument();
    expect(deleted).toBe(true);
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'How are duplicates found?' })).toBeInTheDocument();
  });

  it('starts a new conversation without a conversation id', async () => {
    const bodies = answering(makeTurn(), makeTurn());
    setup();
    const user = userEvent.setup();
    const box = await questionBox();
    await user.type(box, 'First{Enter}');
    await screen.findByText('High confidence');
    await user.click(screen.getByRole('button', { name: 'New conversation' }));
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(box).toHaveFocus();
    await user.type(box, 'Second{Enter}');
    await screen.findByText('High confidence');
    expect(bodies[1]).toEqual({ question: 'Second' });
  });
});
