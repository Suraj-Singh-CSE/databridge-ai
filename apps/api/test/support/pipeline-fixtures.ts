import { randomBytes } from 'node:crypto';

import { CANDIDATE_KEY_TYPES } from '../../src/modules/candidates/candidate.types.js';
import type {
  Cluster,
  ClusterSummary,
  GoldenRecord,
} from '../../src/modules/clusters/cluster.types.js';
import type { ScoreSummary } from '../../src/modules/scores/score.types.js';
import type { Repositories } from '../../src/repositories.js';

import type { ClustersHarness } from './clusters-suite.js';

/** What the worker jobs would have written for one project, up to its clusters. */
export interface PipelineContext {
  repos: Repositories;
  harness: ClustersHarness;
  projectId: string;
  ownerId: string;
}

export const newId = () => randomBytes(12).toString('hex');

/** One standardised source of 4 staged records; returns their ids. */
export async function addSource(
  ctx: PipelineContext,
  name: string,
): Promise<{ id: string; ids: string[] }> {
  const { repos, harness, projectId } = ctx;
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
    rowCount: 4,
    columnCount: 2,
    uploadedBy: ctx.ownerId,
  });
  const runId = `${newId()}:1`;
  const ids = Array.from({ length: 4 }, newId).sort();
  await harness.workerStage(repos, {
    projectId,
    sourceId: id,
    runId,
    rows: ids.map((rowId, index) => ({
      id: rowId,
      rowNumber: index + 1,
      sourceRecordId: `R${index + 1}`,
      fields: { full_name: 'Asha Rao', phone: '+919820012345' },
      issues: [],
    })),
    source: {
      status: 'standardised',
      standardisedAt: new Date('2026-11-22T10:00:00Z'),
      standardisation: { runId, rowCount: 4, rowsWithIssues: 0, issues: [] },
    },
  });
  return { id, ids };
}

/** Candidate pairs (one pair) of the project's current sources; returns the run id. */
export async function findCandidates(
  ctx: PipelineContext,
  pair: [string, string],
): Promise<string> {
  const sources = await ctx.repos.sources.listByProject(ctx.projectId);
  const runId = `${newId()}:1`;
  const zero = CANDIDATE_KEY_TYPES.map((key) => ({ key, count: 0 }));
  await ctx.harness.workerCandidates(ctx.repos, {
    projectId: ctx.projectId,
    pairs: [{ position: 1, recordA: pair[0], recordB: pair[1], keys: ['phone'] }],
    summary: {
      jobId: runId.split(':')[0] ?? '',
      runId,
      sources: sources.map((s) => ({
        sourceId: s.id,
        runId: s.standardisation?.runId ?? '',
        rowCount: s.rowCount ?? 0,
      })),
      recordCount: 4,
      possiblePairs: 6,
      pairCount: 1,
      reductionRatio: 0.8,
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

export async function score(
  ctx: PipelineContext,
  candidatesRunId: string,
  pair: [string, string],
): Promise<ScoreSummary> {
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
    aiReview: null,
  };
  await ctx.harness.workerScores(ctx.repos, {
    projectId: ctx.projectId,
    summary,
    scores: [
      {
        position: 1,
        recordA: pair[0],
        recordB: pair[1],
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

export function clusterOf(position: number, members: string[]): Cluster {
  const [first = '', second = ''] = members;
  return {
    position,
    customerId: `C${randomBytes(6).toString('hex').toUpperCase()}`,
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
  };
}

const goldenOf = (c: Cluster): GoldenRecord => ({
  customerId: c.customerId,
  status: 'proposed',
  fields: { customer_id: c.customerId, full_name: 'Asha Rao' },
  provenance: {},
});

export async function buildClusters(
  ctx: PipelineContext,
  clusters: Cluster[],
  scores: ScoreSummary,
): Promise<void> {
  const runId = `${newId()}:1`;
  const summary: ClusterSummary = {
    jobId: runId.split(':')[0] ?? '',
    runId,
    scoresRunId: scores.runId,
    candidatesRunId: scores.candidatesRunId,
    aiReviewJobId: null,
    recordCount: 4,
    clusterCount: clusters.length,
    singletonCount: clusters.filter((c) => c.size === 1).length,
    multiRecordCount: clusters.filter((c) => c.size > 1).length,
    needsReviewCount: 0,
    aiSuggestedCount: 0,
    averageSize: 1.33,
    largestCluster: 2,
    decisionCount: 0,
    staleDecisionCount: 0,
    cutLinkCount: 0,
    conflictingDecisionCount: 0,
    settings: { includeAiSuggested: true, maxClusterSize: 6, sourceTrust: ['crm'] },
    finishedAt: new Date('2026-11-22T13:00:00Z'),
  };
  await ctx.harness.workerClusters(ctx.repos, {
    projectId: ctx.projectId,
    clusters,
    golden: clusters.map(goldenOf),
    summary,
  });
}

/** Sources, pairs, scores and three clusters (one pair, two singles); nothing approved. */
export async function prepareClusters(
  ctx: PipelineContext,
): Promise<{ clusters: Cluster[]; scores: ScoreSummary }> {
  const { ids } = await addSource(ctx, 'crm_customers');
  const [a = '', b = '', c = '', d = ''] = ids;
  const pair: [string, string] = [a, b];
  const scores = await score(ctx, await findCandidates(ctx, pair), pair);
  const clusters = [clusterOf(1, [a, b]), clusterOf(2, [c]), clusterOf(3, [d])];
  await buildClusters(ctx, clusters, scores);
  return { clusters, scores };
}
