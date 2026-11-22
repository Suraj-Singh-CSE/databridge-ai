import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import type {
  CandidateRecord,
  CandidateSummaryView,
  ClusterSummary,
  ClusterSummaryView,
  ClusterView,
  Job,
  ProjectRole,
  ScoreSummaryView,
  Source,
} from '@/lib/api-types';
import { ApiError } from '@/lib/api';
import {
  API,
  fail,
  jobFrame,
  makeJob,
  makeProject,
  makeSession,
  makeSource,
  ok,
  signedInHandlers,
  sseChannel,
} from '@/test/fixtures';
import { renderApp } from '@/test/render-app';
import { server } from '@/test/server';

import { clusterConfidence, jobErrorText } from './matching-labels';

const PROJECT_ID = '64b0000000000000000000a1';
const CRM_ID = '64b0000000000000000000c1';
const BILLING_ID = '64b0000000000000000000c2';
const PATH = `/projects/${PROJECT_ID}/matching`;
const USER_ID = '64b000000000000000000001';

const CLEANED = {
  status: 'standardised' as const,
  standardisedAt: '2026-11-22T10:00:00.000Z',
  standardisation: { runId: 's1', rowCount: 2014, rowsWithIssues: 12, issues: [] },
};

const CANDIDATES: CandidateSummaryView = {
  outdated: false,
  summary: {
    jobId: 'j-c',
    runId: 'c1',
    sources: [],
    recordCount: 3720,
    possiblePairs: 6_000_000,
    pairCount: 1234,
    reductionRatio: 0.999,
    pairsByKey: [],
    pairsOnlyByKey: [],
    oversizeBlocksSkipped: 0,
    oversizeBlocksByKey: [],
    maxBlockSize: 20,
    finishedAt: '2026-11-22T10:05:00.000Z',
  },
};

function scoresOf(maybe = 27, aiReview = false, outdated = false): ScoreSummaryView {
  return {
    outdated,
    summary: {
      jobId: 'j-s',
      runId: 'sc1',
      candidatesRunId: 'c1',
      pairCount: 1234,
      bandCounts: [
        { band: 'match', count: 412 },
        { band: 'maybe', count: maybe },
        { band: 'non_match', count: 795 },
      ],
      thresholds: { match: 0.9, maybe: 0.5 },
      model: {
        method: 'em',
        emIterations: 10,
        emConverged: true,
        fallbackReason: null,
        matchProportion: 0.3,
        priorWeight: -2,
        fields: [],
      },
      finishedAt: '2026-11-22T10:06:00.000Z',
      aiReview: aiReview
        ? {
            jobId: 'j-r',
            promptVersion: 'v1',
            model: 'mock',
            confidenceThreshold: 0.8,
            pairCount: 27,
            reviewed: 25,
            same: 15,
            different: 8,
            unsure: 2,
            unavailable: 2,
            suggestedMatch: 14,
            suggestedNonMatch: 7,
            calls: 3,
            failedCalls: 0,
            finishedAt: '2026-11-22T10:07:00.000Z',
          }
        : null,
    },
  };
}

const SUMMARY: ClusterSummary = {
  jobId: 'j-k',
  runId: 'k1',
  scoresRunId: 'sc1',
  candidatesRunId: 'c1',
  aiReviewJobId: null,
  recordCount: 3720,
  clusterCount: 2986,
  singletonCount: 2574,
  multiRecordCount: 412,
  needsReviewCount: 27,
  aiSuggestedCount: 9,
  averageSize: 1.2,
  largestCluster: 4,
  decisionCount: 0,
  staleDecisionCount: 0,
  cutLinkCount: 0,
  conflictingDecisionCount: 0,
  settings: { includeAiSuggested: true, maxClusterSize: 50, sourceTrust: ['crm'] },
  finishedAt: '2026-11-22T10:08:00.000Z',
};

const REVIEW: ClusterSummaryView['review'] = {
  approvedCount: 0,
  proposedCount: 2986,
  approvableHighCount: 1,
  sameDecisionCount: 0,
  differentDecisionCount: 0,
};

function clustersOf(
  outdated = false,
  review: Partial<ClusterSummaryView['review']> = {},
  summary: Partial<ClusterSummary> = {},
): ClusterSummaryView {
  return { summary: { ...SUMMARY, ...summary }, outdated, review: { ...REVIEW, ...review } };
}

function record(id: string, source: string, row: number, fields: Record<string, string | null>) {
  const r: CandidateRecord = {
    id,
    sourceId: source === 'CRM' ? CRM_ID : BILLING_ID,
    sourceName: source,
    rowNumber: row,
    sourceRecordId: `${source}-${row}`,
    fields,
    issues: [],
  };
  return r;
}

const RAHUL: ClusterView = {
  position: 1,
  customerId: 'C0123456789AB',
  memberRecordIds: ['r1', 'r2'],
  size: 2,
  confidence: 0.97,
  label: 'High',
  status: 'proposed',
  flags: [],
  reasons: [],
  aiSuggested: false,
  approval: null,
  membershipChanged: false,
  links: [{ recordA: 'r1', recordB: 'r2', score: 0.97, kind: 'match', tree: true }],
  members: [
    record('r1', 'CRM', 12, { full_name: 'Rahul Sharma', phone: '+919820012345' }),
    record('r2', 'Billing', 40, { full_name: 'R. Sharma', phone: '+919820012345' }),
  ],
  goldenRecord: {
    customerId: 'C0123456789AB',
    status: 'proposed',
    fields: { customer_id: 'C0123456789AB', full_name: 'Rahul Sharma', phone: '+919820012345' },
    provenance: {
      full_name: {
        recordId: 'r1',
        source: 'CRM',
        rule: 'most_complete',
        alternatives: [
          { value: 'Rahul Sharma', count: 1, recordIds: ['r1'], sources: ['CRM'] },
          { value: 'R. Sharma', count: 1, recordIds: ['r2'], sources: ['Billing'] },
        ],
      },
      phone: {
        recordId: 'r1',
        source: 'CRM',
        rule: 'most_frequent',
        alternatives: [
          {
            value: '+919820012345',
            count: 2,
            recordIds: ['r1', 'r2'],
            sources: ['CRM', 'Billing'],
          },
        ],
      },
    },
  },
};

const PRIYA: ClusterView = {
  ...RAHUL,
  position: 2,
  customerId: 'C0000000000FF',
  memberRecordIds: ['r3', 'r4'],
  confidence: 0.62,
  label: 'Medium',
  flags: ['needs_review'],
  reasons: ['Joined only through an unclear pair.'],
  aiSuggested: true,
  links: [{ recordA: 'r3', recordB: 'r4', score: 0.62, kind: 'ai_suggested', tree: true }],
  members: [
    record('r3', 'CRM', 7, { full_name: 'Priya Rao', phone: null }),
    record('r4', 'Billing', 9, { full_name: 'Priya Rao', phone: '+919811111111' }),
  ],
  goldenRecord: null,
};

const SINGLE: ClusterView = {
  ...RAHUL,
  position: 3,
  customerId: 'C00000000000A',
  memberRecordIds: ['r5'],
  size: 1,
  confidence: null,
  label: null,
  links: [],
  members: [record('r5', 'CRM', 99, { full_name: 'Solo Person', phone: null })],
};

interface Setup {
  sources?: Source[];
  jobs?: Job[];
  member?: ProjectRole;
  candidates?: CandidateSummaryView | null;
  scores?: ScoreSummaryView | null;
  clusters?: ClusterSummaryView | null;
  pages?: { items: ClusterView[]; nextCursor: string | null }[];
}

function notRun(reason: string) {
  return fail(409, 'CONFLICT', 'Not run yet.', { reason });
}

/** Requests to GET /clusters, as query strings. */
let listRequests: string[] = [];

function setup({
  sources = [makeSource(CLEANED), makeSource({ id: BILLING_ID, originalFilename: 'billing.xlsx' })],
  jobs = [],
  member,
  candidates = CANDIDATES,
  scores = scoresOf(),
  clusters = clustersOf(),
  pages = [{ items: [RAHUL, PRIYA], nextCursor: null }],
}: Setup = {}) {
  listRequests = [];
  const project = member
    ? makeProject({
        ownerId: '64b000000000000000000009',
        members: [{ userId: USER_ID, role: member }],
      })
    : makeProject();
  server.use(
    ...signedInHandlers(makeSession(member ?? 'data_steward')),
    http.get(`${API}/projects/:id`, () => ok({ project })),
    http.get(`${API}/projects/:id/sources`, () => ok({ items: sources })),
    http.get(`${API}/projects/:id/jobs`, () => ok({ items: jobs })),
    http.get(`${API}/projects/:id/candidates/summary`, () =>
      candidates ? ok(candidates) : notRun('CANDIDATES_NOT_RUN'),
    ),
    http.get(`${API}/projects/:id/scores/summary`, () =>
      scores ? ok(scores) : notRun('SCORES_NOT_RUN'),
    ),
    http.get(`${API}/projects/:id/clusters/summary`, () =>
      clusters ? ok(clusters) : notRun('CLUSTERS_NOT_RUN'),
    ),
    http.get(`${API}/projects/:id/clusters`, ({ request }) => {
      const query = new URL(request.url).searchParams;
      listRequests.push(query.toString());
      const index = query.get('cursor') ? Number(query.get('cursor')) : 0;
      const page = pages[index] ?? { items: [], nextCursor: null };
      return ok({ ...clustersOf(), ...page });
    }),
    http.get(`${API}/projects/:id/clusters/:customerId`, ({ params }) => {
      const all = pages.flatMap((p) => p.items);
      const found = all.find((c) => c.customerId === params.customerId);
      return found
        ? ok({ ...clustersOf(), cluster: found })
        : fail(404, 'NOT_FOUND', 'No cluster with this customer id in the current proposals.');
    }),
  );
  return renderApp(PATH);
}

function step(name: string): HTMLElement {
  const heading = screen.getByRole('heading', { name: new RegExp(name) });
  const item = heading.closest('li');
  if (!item) throw new Error(`no step ${name}`);
  return item;
}

async function pipelineReady() {
  await screen.findByRole('heading', { name: 'Prepare matching' });
  await waitFor(() => {
    expect(within(step('Group records')).queryByLabelText(/Loading/)).not.toBeInTheDocument();
  });
}

describe('matching pipeline', () => {
  it('shows each step with its state and counts', async () => {
    setup({ scores: scoresOf(27, true), member: 'data_engineer' });
    await pipelineReady();

    const clean = step('Clean data');
    expect(within(clean).getByText('crm_customers.csv')).toBeInTheDocument();
    expect(within(clean).getByText('2,014 rows cleaned · 12 with issues')).toBeInTheDocument();
    expect(
      within(clean).getByRole('button', { name: 'Re-clean: Clean crm_customers.csv' }),
    ).toBeEnabled();
    expect(within(clean).getByRole('button', { name: 'Clean: Clean billing.xlsx' })).toBeEnabled();
    expect(within(clean).getAllByText('Not run').length).toBeGreaterThan(0);

    const pairs = step('Find possible duplicates');
    expect(within(pairs).getByText('Done')).toBeInTheDocument();
    expect(within(pairs).getByText('1,234 possible pairs among 3,720 records')).toBeInTheDocument();
    expect(
      within(pairs).getByRole('button', { name: 'Re-run: Find possible duplicates' }),
    ).toBeEnabled();

    expect(
      within(step('Score pairs')).getByText(
        '412 likely matches · 27 unclear pairs · 795 likely different',
      ),
    ).toBeInTheDocument();
    expect(
      within(step('AI review')).getByText(
        '25 pairs reviewed · 14 suggested same · 7 suggested different',
      ),
    ).toBeInTheDocument();
    expect(within(step('AI review')).getByText('Optional')).toBeInTheDocument();
    expect(
      within(step('Group records')).getByText('2,986 customers found from 3,720 records'),
    ).toBeInTheDocument();
  });

  it('shows steps that have not run, and blocks the AI review until there are scores', async () => {
    setup({ member: 'data_engineer', candidates: null, scores: null, clusters: null });
    await pipelineReady();

    expect(within(step('Find possible duplicates')).getByText('Not run yet.')).toBeInTheDocument();
    expect(
      within(step('Find possible duplicates')).getByRole('button', {
        name: 'Run: Find possible duplicates',
      }),
    ).toBeEnabled();
    const review = step('AI review');
    expect(
      within(review).getByRole('button', { name: 'Run: AI review of unclear pairs' }),
    ).toBeDisabled();
    expect(within(review).getByText('Score the pairs first.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'No customers yet' })).toBeInTheDocument();
  });

  it('disables the AI review when there are no unclear pairs', async () => {
    setup({ member: 'data_engineer', scores: scoresOf(0) });
    await pipelineReady();

    const review = step('AI review');
    expect(
      within(review).getByRole('button', { name: /AI review of unclear pairs/ }),
    ).toBeDisabled();
    expect(within(review).getByText('No unclear pairs to review.')).toBeInTheDocument();
  });

  it('marks outdated steps and a file changed after cleaning', async () => {
    setup({
      member: 'data_engineer',
      sources: [makeSource({ ...CLEANED, status: 'profiled' })],
      candidates: { ...CANDIDATES, outdated: true },
      clusters: clustersOf(true),
    });
    await pipelineReady();

    expect(within(step('Clean data')).getAllByText('Out of date').length).toBeGreaterThan(0);
    expect(
      within(step('Clean data')).getByRole('button', { name: 'Re-clean: Clean crm_customers.csv' }),
    ).toBeInTheDocument();
    const pairs = step('Find possible duplicates');
    expect(within(pairs).getByText('Out of date')).toBeInTheDocument();
    expect(within(pairs).getByText(/Re-run this step/)).toBeInTheDocument();
    expect(screen.getByText('These groups are out of date')).toBeInTheDocument();
  });

  it('asks files that are not profiled to be profiled first', async () => {
    setup({ member: 'data_engineer', sources: [makeSource({ status: 'uploaded' })] });
    await pipelineReady();

    const clean = step('Clean data');
    expect(within(clean).getByText('Profile and map this file first.')).toBeInTheDocument();
    expect(within(clean).queryByRole('button')).not.toBeInTheDocument();
  });

  it('starts the right job, shows live progress and re-reads the results when done', async () => {
    const events = sseChannel();
    let started: unknown = null;
    let finished = false;
    const job = makeJob({
      type: 'candidates',
      status: 'queued',
      progress: 0,
      message: '',
      payload: {},
    });
    setup({ member: 'data_engineer', candidates: null, scores: null, clusters: null });
    server.use(
      http.post(`${API}/projects/:id/jobs`, async ({ request }) => {
        started = await request.json();
        return ok({ job }, 202);
      }),
      http.get(`${API}/jobs/:id/events`, () => events.response()),
      http.get(`${API}/projects/:id/candidates/summary`, () =>
        finished ? ok(CANDIDATES) : notRun('CANDIDATES_NOT_RUN'),
      ),
    );
    const user = userEvent.setup();
    await pipelineReady();

    await user.click(screen.getByRole('button', { name: 'Run: Find possible duplicates' }));
    await waitFor(() => {
      expect(started).toEqual({ type: 'candidates', payload: {} });
    });
    const pairs = step('Find possible duplicates');
    expect(await within(pairs).findByText('Waiting to start')).toBeInTheDocument();
    events.send(jobFrame({ status: 'running', progress: 40, message: 'Blocking on phone' }));
    expect(await within(pairs).findByText('40% done')).toBeInTheDocument();
    expect(
      within(pairs).getByRole('progressbar', { name: 'Find possible duplicates' }),
    ).toHaveAttribute('aria-valuenow', '40');
    expect(
      within(pairs).getByRole('button', { name: 'Cancel: Find possible duplicates' }),
    ).toBeEnabled();

    finished = true;
    events.send(jobFrame({ status: 'succeeded', progress: 100, message: 'Done' }));
    events.close();
    expect(
      await within(step('Find possible duplicates')).findByText(
        '1,234 possible pairs among 3,720 records',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('cleans one file with its source id', async () => {
    let started: unknown = null;
    setup({ member: 'data_engineer' });
    server.use(
      http.post(`${API}/projects/:id/jobs`, async ({ request }) => {
        started = await request.json();
        return ok(
          {
            job: makeJob({
              type: 'standardise',
              status: 'queued',
              payload: { sourceId: BILLING_ID },
            }),
          },
          202,
        );
      }),
      http.get(`${API}/jobs/:id/events`, () => sseChannel().response()),
    );
    const user = userEvent.setup();
    await pipelineReady();

    await user.click(screen.getByRole('button', { name: 'Clean: Clean billing.xlsx' }));
    await waitFor(() => {
      expect(started).toEqual({ type: 'standardise', payload: { sourceId: BILLING_ID } });
    });
    expect(
      await screen.findByRole('progressbar', { name: 'Clean billing.xlsx' }),
    ).toBeInTheDocument();
  });

  it('cancels a running job', async () => {
    let cancelled = '';
    const running = makeJob({ type: 'scoring', status: 'running', progress: 50, payload: {} });
    setup({ member: 'data_engineer', jobs: [running] });
    server.use(
      http.get(`${API}/jobs/:id/events`, () => sseChannel().response()),
      http.post(`${API}/jobs/:id/cancel`, ({ params }) => {
        cancelled = String(params.id);
        return ok({ job: { ...running, status: 'cancelled' } });
      }),
    );
    const user = userEvent.setup();
    await pipelineReady();

    await user.click(screen.getByRole('button', { name: 'Cancel: Score pairs' }));
    await waitFor(() => {
      expect(cancelled).toBe(running.id);
    });
  });

  it('explains a mapping that is not approved, with a link to Mapping', async () => {
    setup({ member: 'data_engineer' });
    server.use(
      http.post(`${API}/projects/:id/jobs`, () =>
        fail(409, 'CONFLICT', '2 columns still need a decision.', {
          reason: 'MAPPING_NOT_APPROVED',
          pending: 2,
        }),
      ),
    );
    const user = userEvent.setup();
    await pipelineReady();

    await user.click(screen.getByRole('button', { name: 'Clean: Clean billing.xlsx' }));
    expect(await screen.findByText(/still need a mapping decision/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Mapping' })).toHaveAttribute(
      'href',
      `/projects/${PROJECT_ID}/mapping?source=${BILLING_ID}`,
    );
  });

  it('explains outdated scores in plain words', async () => {
    setup({ member: 'data_engineer' });
    server.use(
      http.post(`${API}/projects/:id/jobs`, () =>
        fail(409, 'CONFLICT', 'The scores are out of date.', { reason: 'SCORES_OUTDATED' }),
      ),
    );
    const user = userEvent.setup();
    await pipelineReady();

    await user.click(screen.getByRole('button', { name: 'Re-run: Group records' }));
    expect(
      await within(step('Group records')).findByText(
        'The scores are out of date. Re-run step 3 first.',
      ),
    ).toBeInTheDocument();
  });

  it('shows the last failure of a step', async () => {
    setup({
      member: 'data_engineer',
      jobs: [
        makeJob({
          type: 'clustering',
          status: 'failed',
          payload: {},
          error: { code: 'X', message: 'The worker stopped.' },
        }),
      ],
    });
    await pipelineReady();

    expect(
      within(step('Group records')).getByText(/The last run failed: The worker stopped./),
    ).toBeInTheDocument();
  });

  it('shows an error with a retry when a summary cannot be loaded', async () => {
    let calls = 0;
    setup({ member: 'data_engineer' });
    server.use(
      http.get(`${API}/projects/:id/scores/summary`, () => {
        calls += 1;
        return calls === 1 ? fail(403, 'FORBIDDEN', 'Not allowed.') : ok(scoresOf());
      }),
    );
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Prepare matching' });

    const score = step('Score pairs');
    expect(await within(score).findByText(/We could not load the scores/)).toBeInTheDocument();
    await user.click(within(score).getByRole('button', { name: 'Try again' }));
    expect(await within(step('Score pairs')).findByText(/412 likely matches/)).toBeInTheDocument();
  });

  it('shows an error when the files cannot be loaded', async () => {
    setup();
    server.use(
      http.get(`${API}/projects/:id/sources`, () => fail(400, 'VALIDATION_ERROR', 'Bad request.')),
    );

    expect(await screen.findByText('We could not load the files')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('matching roles', () => {
  it('shows viewers a read-only page without run buttons', async () => {
    setup({ member: 'viewer' });
    await pipelineReady();

    expect(screen.getByText(/You can view the matching results/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^(Run|Re-run|Clean|Re-clean):/ }),
    ).not.toBeInTheDocument();
    expect(await screen.findByRole('table', { name: 'Customers found' })).toBeInTheDocument();
  });

  it('does not let data stewards run jobs or cancel them', async () => {
    const running = makeJob({ type: 'scoring', status: 'running', progress: 50, payload: {} });
    setup({ member: 'data_steward', jobs: [running] });
    server.use(http.get(`${API}/jobs/:id/events`, () => sseChannel().response()));
    await pipelineReady();

    expect(screen.getByText(/You can approve, split and merge customers/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^(Run|Re-run|Clean|Re-clean|Cancel):/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Score pairs' })).toBeInTheDocument();
  });

  it('lets data engineers run every step', async () => {
    setup({ member: 'data_engineer' });
    await pipelineReady();

    expect(screen.queryByText(/You can view the matching results/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Re-run: Group records' })).toBeEnabled();
  });
});

describe('customers found', () => {
  it('shows the summary cards', async () => {
    setup();
    await screen.findByRole('heading', { name: 'Customers found' });

    const cards = [
      ['People found', '2,986'],
      ['Records merged', '412'],
      ['Need review', '27'],
      ['AI suggested', '9'],
      ['Largest group', '4'],
    ];
    for (const [label, value] of cards) {
      const card = screen.getAllByText(label ?? '').find((el) => el.tagName === 'P')?.parentElement;
      expect(card).toHaveTextContent(value ?? '');
    }
    expect(screen.getByText('from 3,720 records')).toBeInTheDocument();
  });

  it('lists customers with confidence, flags and status as text', async () => {
    setup();
    const table = await screen.findByRole('table', { name: 'Customers found' });

    const rahul = within(table).getByRole('rowheader', { name: 'C0123456789AB' }).closest('tr');
    expect(rahul).toHaveTextContent('High · 97%');
    expect(rahul).toHaveTextContent('Proposed');
    const priya = within(table).getByRole('rowheader', { name: 'C0000000000FF' }).closest('tr');
    expect(priya).toHaveTextContent('Medium · 62%');
    expect(priya).toHaveTextContent('Needs review');
    expect(priya).toHaveTextContent('AI suggested');
    expect(priya).toHaveTextContent('Joined only through an unclear pair.');
  });

  it('asks for multi-record customers by default and filters by flag and size', async () => {
    setup({ pages: [{ items: [RAHUL, PRIYA, SINGLE], nextCursor: null }] });
    const user = userEvent.setup();
    await screen.findByRole('table', { name: 'Customers found' });

    expect(listRequests.at(-1)).toBe('limit=20&minSize=2');
    expect(screen.getByRole('button', { name: '2 or more records' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.click(screen.getByRole('button', { name: 'Needs review' }));
    await waitFor(() => {
      expect(listRequests.at(-1)).toBe('limit=20&flag=needs_review&minSize=2');
    });
    await user.click(screen.getByRole('button', { name: '2 or more records' }));
    await waitFor(() => {
      expect(listRequests.at(-1)).toBe('limit=20&flag=needs_review');
    });
    expect(await screen.findByText('Single record')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'AI suggested' }));
    await waitFor(() => {
      expect(listRequests.at(-1)).toBe('limit=20&flag=needs_review&aiSuggested=true');
    });
    await user.click(screen.getByRole('button', { name: 'Approved' }));
    await waitFor(() => {
      expect(listRequests.at(-1)).toBe(
        'limit=20&flag=needs_review&aiSuggested=true&status=approved',
      );
    });
    await user.click(screen.getByRole('button', { name: 'Not approved' }));
    expect(screen.getByRole('button', { name: 'Approved' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await waitFor(() => {
      expect(listRequests.at(-1)).toBe(
        'limit=20&flag=needs_review&aiSuggested=true&status=proposed',
      );
    });
  });

  it('pages with the api cursor', async () => {
    setup({
      pages: [
        { items: [RAHUL], nextCursor: '1' },
        { items: [PRIYA], nextCursor: null },
      ],
    });
    const user = userEvent.setup();
    await screen.findByRole('rowheader', { name: 'C0123456789AB' });

    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('rowheader', { name: 'C0000000000FF' })).toBeInTheDocument();
    expect(listRequests.at(-1)).toBe('limit=20&minSize=2&cursor=1');
    expect(screen.getByText('Page 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByRole('rowheader', { name: 'C0123456789AB' })).toBeInTheDocument();
  });

  it('finds a customer by id, and says when there is none', async () => {
    setup();
    const user = userEvent.setup();
    await screen.findByRole('table', { name: 'Customers found' });
    const box = screen.getByRole('searchbox', { name: 'Search by customer id' });

    await user.type(box, 'nope{Enter}');
    expect(screen.getByText('Enter a customer id such as C1A2B3C4D5E6F.')).toBeInTheDocument();

    await user.clear(box);
    await user.type(box, 'c0000000000ff{Enter}');
    expect(
      await screen.findByRole('heading', { name: /Customer C0000000000FF/ }),
    ).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Customers found' });
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((c) => c.textContent),
    ).toEqual(['C0000000000FF']);

    await user.clear(box);
    await user.type(box, 'C999999999999{Enter}');
    expect(
      await screen.findByRole('heading', { name: 'No customer C999999999999' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(await screen.findByRole('rowheader', { name: 'C0123456789AB' })).toBeInTheDocument();
  });

  it('says when no customers match the filters, and shows list errors', async () => {
    setup({ pages: [{ items: [], nextCursor: null }] });
    expect(
      await screen.findByRole('heading', { name: 'No customers match these filters' }),
    ).toBeInTheDocument();

    server.use(
      http.get(`${API}/projects/:id/clusters`, async () => {
        await delay(10);
        return fail(400, 'VALIDATION_ERROR', 'Bad filter.');
      }),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Needs review' }));
    expect(await screen.findByText(/We could not load the customers/)).toBeInTheDocument();
  });
});

describe('customer details', () => {
  async function openRahul() {
    setup();
    const user = userEvent.setup();
    const button = await screen.findByRole('button', { name: 'Details for C0123456789AB' });
    button.focus();
    await user.keyboard('{Enter}');
    expect(button).toHaveAttribute('aria-expanded', 'true');
    return { user, detail: screen.getByRole('region', { name: /Customer C0123456789AB/ }) };
  }

  it('shows the records side by side with the golden record and where each value came from', async () => {
    const { detail } = await openRahul();
    const table = within(detail).getByRole('table', { name: 'Records of customer C0123456789AB' });

    const headers = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers).toEqual([
      'Field',
      'CRMRow 12 · ID CRM-12Split out',
      'BillingRow 40 · ID Billing-40Split out',
      'Golden record',
    ]);
    const name = within(table).getByRole('rowheader', { name: 'full_name' }).closest('tr');
    if (!name) throw new Error('no row');
    const cells = within(name).getAllByRole('cell');
    expect(cells[0]).not.toHaveTextContent('Differs');
    expect(cells[1]).toHaveTextContent('R. SharmaDiffers');
    expect(cells[2]).toHaveTextContent('Rahul Sharma');
    expect(cells[2]).toHaveTextContent('From CRM row 12 · most complete');
    const phone = within(table).getByRole('rowheader', { name: 'phone' }).closest('tr');
    expect(phone).not.toHaveTextContent('Differs');
    expect(phone).toHaveTextContent('From CRM row 12 · most frequent');
    expect(within(table).queryByRole('rowheader', { name: 'customer_id' })).not.toBeInTheDocument();

    expect(within(detail).getByText(/CRM row 12 and Billing row 40/)).toHaveTextContent(
      'CRM row 12 and Billing row 40: 97% match score · Match by score',
    );
  });

  it('opens the other values with the keyboard', async () => {
    const { user, detail } = await openRahul();
    const toggle = within(detail).getByRole('button', { name: 'full_name: all 2 values' });
    expect(within(detail).queryByText(/1 record \(Billing\)/)).not.toBeInTheDocument();

    toggle.focus();
    await user.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(detail).getByText('· 1 record (Billing)')).toBeInTheDocument();
    await user.keyboard(' ');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(detail).queryByRole('button', { name: /phone: all/ })).not.toBeInTheDocument();
  });

  it('closes the details', async () => {
    const { user, detail } = await openRahul();
    await user.click(within(detail).getByRole('button', { name: 'Close details' }));
    expect(
      screen.queryByRole('region', { name: /Customer C0123456789AB/ }),
    ).not.toBeInTheDocument();
  });

  it('shows flags and says when there is no golden record', async () => {
    setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Details for C0000000000FF' }));
    const detail = screen.getByRole('region', { name: /Customer C0000000000FF/ });

    expect(
      within(detail).getByText('No golden record was proposed for this group.'),
    ).toBeInTheDocument();
    expect(within(detail).getByText('Needs review')).toBeInTheDocument();
    expect(within(detail).getByText(/AI suggested$/)).toBeInTheDocument();
    expect(within(detail).queryByText('Differs')).not.toBeInTheDocument();
  });
});

describe('match review decisions', () => {
  const CUSTOMER = 'C0123456789AB';

  /** Records every review request as `METHOD path body`. */
  function recordRequests() {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const take = async (request: Request) => {
      const url = new URL(request.url);
      const text = request.method === 'DELETE' ? '' : await request.text();
      calls.push({
        method: request.method,
        path: url.pathname.replace(`/api/v1/projects/${PROJECT_ID}/clusters`, ''),
        body: text ? (JSON.parse(text) as unknown) : null,
      });
    };
    return { calls, take };
  }

  async function openRahul(member: ProjectRole = 'data_steward', overrides: Setup = {}) {
    setup({ member, ...overrides });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: `Details for ${CUSTOMER}` }));
    return { user, detail: screen.getByRole('region', { name: /Customer C0123456789AB/ }) };
  }

  it('approves a group and announces it', async () => {
    const { calls, take } = recordRequests();
    server.use(
      http.post(`${API}/projects/:id/clusters/:customerId/approve`, async ({ request }) => {
        await take(request);
        return ok({ customerId: CUSTOMER, status: 'approved', approvedAt: '2026-11-23T10:00:00Z' });
      }),
    );
    const { user, detail } = await openRahul();
    expect(within(detail).getByText('Proposed')).toBeInTheDocument();

    await user.click(within(detail).getByRole('button', { name: 'Approve group' }));

    expect(await screen.findByText(`Approved customer ${CUSTOMER}.`)).toHaveAttribute(
      'aria-live',
      'polite',
    );
    expect(calls).toEqual([{ method: 'POST', path: `/${CUSTOMER}/approve`, body: {} }]);
  });

  it('splits a record out after a confirm with a reason, then follows the rebuild job', async () => {
    const events = sseChannel();
    const { calls, take } = recordRequests();
    const job = makeJob({ type: 'clustering', status: 'queued', progress: 0, payload: {} });
    let rebuilt = false;
    server.use(
      http.post(`${API}/projects/:id/clusters/:customerId/split`, async ({ request }) => {
        await take(request);
        return ok({ decisionsWritten: 1, job, jobMessage: null });
      }),
      http.get(`${API}/jobs/:id/events`, () => events.response()),
    );
    const { user, detail } = await openRahul();
    server.use(
      http.get(`${API}/projects/:id/clusters`, ({ request }) => {
        listRequests.push(new URL(request.url).searchParams.toString());
        return ok({ ...clustersOf(), items: rebuilt ? [PRIYA] : [RAHUL, PRIYA], nextCursor: null });
      }),
    );

    const trigger = within(detail).getByRole('button', { name: 'Split out CRM row 12' });
    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Split this record out?' });
    expect(dialog).toHaveTextContent('different person from the other 1 record');
    await user.type(within(dialog).getByLabelText('Reason (optional)'), 'Different birth date');
    await user.click(within(dialog).getByRole('button', { name: 'Split out' }));

    await waitFor(() => {
      expect(calls).toEqual([
        {
          method: 'POST',
          path: `/${CUSTOMER}/split`,
          body: { recordId: 'r1', reason: 'Different birth date' },
        },
      ]);
    });
    expect(
      await screen.findByText('Split saved. The groups are being rebuilt.'),
    ).toBeInTheDocument();
    expect(await screen.findByText('Waiting to rebuild the groups')).toBeInTheDocument();
    events.send(jobFrame({ status: 'running', progress: 60 }));
    expect(await screen.findByText('Rebuilding the groups: 60%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve group' })).toBeDisabled();

    rebuilt = true;
    const before = listRequests.length;
    events.send(jobFrame({ status: 'succeeded', progress: 100 }));
    events.close();
    await waitFor(() => {
      expect(listRequests.length).toBeGreaterThan(before);
    });
    await waitFor(() => {
      expect(screen.queryByRole('rowheader', { name: CUSTOMER })).not.toBeInTheDocument();
    });
  });

  it('returns focus to the trigger when a split is cancelled', async () => {
    const { user, detail } = await openRahul();
    const trigger = within(detail).getByRole('button', { name: 'Split out Billing row 40' });
    await user.click(trigger);
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });
  });

  it('merges with another customer found by id, showing both sizes', async () => {
    const { calls, take } = recordRequests();
    server.use(
      http.post(`${API}/projects/:id/clusters/merge`, async ({ request }) => {
        await take(request);
        return ok({
          decisionsWritten: 1,
          job: null,
          jobMessage: 'Your decision is saved, but the clusters could not be rebuilt yet: busy.',
        });
      }),
    );
    const { user, detail } = await openRahul();

    await user.click(within(detail).getByRole('button', { name: 'Merge with…' }));
    const dialog = screen.getByRole('dialog', { name: 'Merge with another customer' });
    const box = within(dialog).getByLabelText('Other customer id');
    expect(within(dialog).getByRole('button', { name: 'Merge customers' })).toBeDisabled();
    await user.type(box, `${CUSTOMER}{Enter}`);
    expect(within(dialog).getByText(/Pick a different customer/)).toBeInTheDocument();
    await user.clear(box);
    await user.type(box, 'c0000000000ff{Enter}');
    expect(await within(dialog).findByText(/into one customer of 4 records/)).toHaveTextContent(
      'Merge C0123456789AB (2 records) with C0000000000FF (2 records)',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Merge customers' }));

    await waitFor(() => {
      expect(calls).toEqual([
        { method: 'POST', path: '/merge', body: { customerIds: [CUSTOMER, 'C0000000000FF'] } },
      ]);
    });
    expect(await screen.findByText(/Your decision is saved, but/)).toBeInTheDocument();
  });

  it('approves all High groups after a confirm that shows the count', async () => {
    const { calls, take } = recordRequests();
    server.use(
      http.post(`${API}/projects/:id/clusters/approve-high`, async ({ request }) => {
        await take(request);
        return ok({ approved: 3, alreadyApproved: 2 });
      }),
    );
    setup({ clusters: clustersOf(false, { approvableHighCount: 3 }) });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Approve all High' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve 3 High-confidence groups?' });
    await user.click(within(dialog).getByRole('button', { name: 'Approve 3' }));

    expect(
      await screen.findByText('Approved 3 groups. 2 were already approved.'),
    ).toBeInTheDocument();
    expect(calls).toEqual([{ method: 'POST', path: '/approve-high', body: {} }]);
  });

  it('turns Approve all High off when nothing is waiting', async () => {
    setup({ clusters: clustersOf(false, { approvableHighCount: 0 }) });
    expect(await screen.findByRole('button', { name: 'Approve all High' })).toBeDisabled();
    expect(
      screen.getByText('No High-confidence groups are waiting for approval.'),
    ).toBeInTheDocument();
  });

  it('shows approved and membership-changed states, and undoes an approval', async () => {
    const { calls, take } = recordRequests();
    const approved: ClusterView = {
      ...RAHUL,
      status: 'approved',
      approval: { approvedBy: USER_ID, approvedAt: '2026-11-23T10:00:00Z' },
    };
    const changed: ClusterView = { ...PRIYA, membershipChanged: true };
    server.use(
      http.delete(`${API}/projects/:id/clusters/:customerId/approval`, async ({ request }) => {
        await take(request);
        return ok({ customerId: CUSTOMER, status: 'proposed' });
      }),
    );
    const { user, detail } = await openRahul('data_steward', {
      pages: [{ items: [approved, changed], nextCursor: null }],
    });
    const table = screen.getByRole('table', { name: 'Customers found' });
    expect(
      within(table).getByRole('rowheader', { name: 'C0000000000FF' }).closest('tr'),
    ).toHaveTextContent('Membership changed');
    expect(within(detail).getByText('Approved')).toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: 'Approve group' })).not.toBeInTheDocument();

    await user.click(within(detail).getByRole('button', { name: 'Undo approval' }));
    await user.click(
      within(screen.getByRole('dialog', { name: 'Undo this approval?' })).getByRole('button', {
        name: 'Undo approval',
      }),
    );
    await waitFor(() => {
      expect(calls).toEqual([{ method: 'DELETE', path: `/${CUSTOMER}/approval`, body: null }]);
    });

    await user.click(screen.getByRole('button', { name: 'Details for C0000000000FF' }));
    expect(screen.getByText(/Membership changed since approval/)).toBeInTheDocument();
  });

  it('shows the evidence behind each link from the detail', async () => {
    const evidence = {
      score: 0.97,
      band: 'match' as const,
      reasons: [{ field: 'phone', level: 'exact', weight: 7, text: 'Same phone' }],
      aiDecision: 'same' as const,
      aiConfidence: 0.9,
      aiReason: 'Same phone and name initial',
      suggestedBand: 'match' as const,
    };
    const withEvidence: ClusterView = {
      ...RAHUL,
      links: RAHUL.links.map((link) => ({ ...link, evidence })),
    };
    const { detail } = await openRahul('viewer', {
      pages: [{ items: [withEvidence], nextCursor: null }],
    });
    await waitFor(() => {
      expect(within(detail).getByText(/CRM row 12 and Billing row 40/)).toHaveTextContent(
        'Match · Same phone · AI says same person (90%): “Same phone and name initial”',
      );
    });
  });

  it('keeps viewers read-only', async () => {
    const { detail } = await openRahul('viewer');
    for (const name of [/Approve group/, /Split out/, /Merge with/, /Undo approval/]) {
      expect(within(detail).queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: 'Approve all High' })).not.toBeInTheDocument();
  });

  it('lets data engineers decide too', async () => {
    const { detail } = await openRahul('data_engineer');
    expect(within(detail).getByRole('button', { name: 'Approve group' })).toBeEnabled();
  });

  it('explains a refused, forbidden or failed decision in plain words', async () => {
    const answers = [
      fail(409, 'CONFLICT', 'Clusters are being rebuilt right now. Wait for that to finish.', {
        reason: 'CLUSTERING_RUNNING',
      }),
      fail(403, 'FORBIDDEN', 'You do not have permission to do this.'),
    ];
    server.use(
      http.post(`${API}/projects/:id/clusters/:customerId/approve`, () => answers.shift()),
    );
    const { user, detail } = await openRahul();
    const approve = within(detail).getByRole('button', { name: 'Approve group' });

    await user.click(approve);
    expect(await screen.findByText(/Clusters are being rebuilt right now/)).toBeInTheDocument();
    await user.click(approve);
    expect(
      await screen.findByText('You do not have permission to review customers in this project.'),
    ).toBeInTheDocument();
    server.use(
      http.post(`${API}/projects/:id/clusters/:customerId/approve`, () => HttpResponse.error()),
    );
    await user.click(approve);
    expect(await screen.findByText(/We could not reach the server/)).toBeInTheDocument();
  });

  it('says how many earlier decisions no longer apply', async () => {
    setup({ clusters: clustersOf(false, {}, { staleDecisionCount: 2 }) });
    expect(await screen.findByText(/2 earlier decisions no longer apply/)).toBeInTheDocument();
  });
});

describe('matching helpers', () => {
  it('labels singletons and confident clusters in words', () => {
    expect(clusterConfidence(SINGLE)).toEqual({ text: 'Single record', tone: 'neutral' });
    expect(clusterConfidence(PRIYA)).toEqual({ text: 'Medium · 62%', tone: 'review' });
  });

  it('turns job errors into plain language', () => {
    expect(jobErrorText(new Error('x')).text).toBe('Something went wrong. Please try again.');
    expect(jobErrorText(new ApiError(403, 'FORBIDDEN', 'no')).text).toMatch(/permission/);
    expect(
      jobErrorText(new ApiError(409, 'CONFLICT', 'Busy.', { reason: 'SCORING_RUNNING' })).text,
    ).toBe('Busy.');
    expect(
      jobErrorText(new ApiError(409, 'CONFLICT', 'm', { reason: 'NO_STANDARDISED_SOURCES' })),
    ).toEqual({ text: 'Clean at least one file first (step 1).', link: null });
  });
});
