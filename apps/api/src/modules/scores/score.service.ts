import { AppError } from '../../errors.js';
import type { Repositories } from '../../repositories.js';
import { candidatesOutdated, type CandidateRecord } from '../candidates/candidate.service.js';
import type { Project } from '../projects/project.types.js';
import type { Source } from '../sources/source.types.js';

import type { PairScore, ScoreBand, ScoreSummary } from './score.types.js';

export interface ScoredPairView extends Omit<PairScore, 'recordA' | 'recordB'> {
  /** null only when the record is gone (its source was standardised again: `outdated`). */
  recordA: CandidateRecord | null;
  recordB: CandidateRecord | null;
}

export interface ScoreSummaryView {
  summary: ScoreSummary;
  /** True when the candidate pairs were found again, or are themselves outdated. */
  outdated: boolean;
}

export interface ScorePage extends ScoreSummaryView {
  items: ScoredPairView[];
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
}

export interface ScoreService {
  summary(project: Project): Promise<ScoreSummaryView>;
  list(
    project: Project,
    query: {
      band?: ScoreBand | undefined;
      suggestedBand?: ScoreBand | undefined;
      limit: number;
      cursor?: number | undefined;
    },
  ): Promise<ScorePage>;
}

export const SCORES_NOT_RUN =
  'The candidate pairs have not been scored yet. Find candidate pairs, then run "Score pairs".';

export function createScoreService(
  repos: Pick<Repositories, 'scores' | 'candidates' | 'sources' | 'stagedRecords'>,
): ScoreService {
  async function current(project: Project): Promise<ScoreSummaryView & { sources: Source[] }> {
    const summary = await repos.scores.findSummary(project.id);
    if (!summary) throw AppError.conflict(SCORES_NOT_RUN, { reason: 'SCORES_NOT_RUN' });
    const sources = await repos.sources.listByProject(project.id);
    const candidates = await repos.candidates.findSummary(project.id);
    // No candidate pairs, or other ones, or pairs that are themselves outdated.
    const outdated =
      candidates?.runId !== summary.candidatesRunId || candidatesOutdated(candidates, sources);
    return { summary, outdated, sources };
  }

  return {
    async summary(project) {
      const { summary, outdated } = await current(project);
      return { summary, outdated };
    },

    async list(project, { band, suggestedBand, limit, cursor }) {
      const { summary, outdated, sources } = await current(project);
      // One extra score tells whether there is a next page.
      const scores = await repos.scores.listScores(project.id, {
        runId: summary.runId,
        band,
        suggestedBand,
        afterPosition: cursor ?? 0,
        limit: limit + 1,
      });
      const page = scores.slice(0, limit);
      const ids = [...new Set(page.flatMap((s) => [s.recordA, s.recordB]))];
      const records = new Map(
        (await repos.stagedRecords.findByIds(project.id, ids)).map((r) => [r.id, r]),
      );
      const names = new Map(sources.map((s) => [s.id, s.name]));
      const side = (id: string): CandidateRecord | null => {
        const record = records.get(id);
        return record ? { ...record, sourceName: names.get(record.sourceId) ?? '' } : null;
      };
      const last = page.at(-1);
      return {
        summary,
        outdated,
        items: page.map((s) => ({ ...s, recordA: side(s.recordA), recordB: side(s.recordB) })),
        nextCursor: scores.length > limit && last ? String(last.position) : null,
      };
    },
  };
}
