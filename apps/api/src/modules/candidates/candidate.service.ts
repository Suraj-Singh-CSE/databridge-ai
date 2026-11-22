import { AppError } from '../../errors.js';
import type { Repositories } from '../../repositories.js';
import type { Project } from '../projects/project.types.js';
import type { Source } from '../sources/source.types.js';
import type { StagedRecordRef } from '../staged/staged.types.js';

import type { CandidateSummary } from './candidate.types.js';

/** One side of a pair: the staged record with its source, for side-by-side review. */
export interface CandidateRecord extends StagedRecordRef {
  sourceName: string;
}

export interface CandidatePairView {
  position: number;
  keys: string[];
  /** null only when the record is gone (its source was standardised again: `outdated`). */
  recordA: CandidateRecord | null;
  recordB: CandidateRecord | null;
}

export interface CandidateSummaryView {
  summary: CandidateSummary;
  /** True when a source was standardised again, re-profiled or added since this run. */
  outdated: boolean;
}

export interface CandidatePage extends CandidateSummaryView {
  items: CandidatePairView[];
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
}

export interface CandidateService {
  summary(project: Project): Promise<CandidateSummaryView>;
  list(
    project: Project,
    query: { limit: number; cursor?: number | undefined },
  ): Promise<CandidatePage>;
}

export const CANDIDATES_NOT_RUN =
  'Candidate pairs have not been found yet. Standardise your sources, then run "Find candidates".';

/** False while the same sources are each still on the run the pairs were built from. */
export function candidatesOutdated(summary: CandidateSummary, sources: Source[]): boolean {
  const current = new Map(
    sources
      .filter((s) => s.status === 'standardised' && s.standardisation)
      .map((s) => [s.id, s.standardisation?.runId]),
  );
  return (
    current.size !== summary.sources.length ||
    summary.sources.some((s) => current.get(s.sourceId) !== s.runId)
  );
}

export function createCandidateService(
  repos: Pick<Repositories, 'candidates' | 'sources' | 'stagedRecords'>,
): CandidateService {
  async function current(project: Project): Promise<CandidateSummaryView & { sources: Source[] }> {
    const summary = await repos.candidates.findSummary(project.id);
    if (!summary) throw AppError.conflict(CANDIDATES_NOT_RUN, { reason: 'CANDIDATES_NOT_RUN' });
    const sources = await repos.sources.listByProject(project.id);
    return { summary, outdated: candidatesOutdated(summary, sources), sources };
  }

  return {
    async summary(project) {
      const { summary, outdated } = await current(project);
      return { summary, outdated };
    },

    async list(project, { limit, cursor }) {
      const { summary, outdated, sources } = await current(project);
      // One extra pair tells whether there is a next page.
      const pairs = await repos.candidates.listPairs(project.id, {
        runId: summary.runId,
        afterPosition: cursor ?? 0,
        limit: limit + 1,
      });
      const page = pairs.slice(0, limit);
      const ids = [...new Set(page.flatMap((p) => [p.recordA, p.recordB]))];
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
        items: page.map((p) => ({
          position: p.position,
          keys: p.keys,
          recordA: side(p.recordA),
          recordB: side(p.recordB),
        })),
        nextCursor: pairs.length > limit && last ? String(last.position) : null,
      };
    },
  };
}
