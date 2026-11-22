import { AppError } from '../../errors.js';
import type { Repositories } from '../../repositories.js';
import type { Project } from '../projects/project.types.js';
import type { Source, StandardisationSummary } from '../sources/source.types.js';

import type { StagedRecord } from './staged.types.js';

export interface StagedPage {
  source: Pick<Source, 'id' | 'name' | 'status' | 'standardisedAt'>;
  summary: StandardisationSummary;
  items: StagedRecord[];
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
}

export interface StagedService {
  list(
    project: Project,
    sourceId: string,
    query: { limit: number; cursor?: number | undefined; issues: 'only' | 'all' },
  ): Promise<StagedPage>;
}

export const NOT_STANDARDISED =
  'This source has not been standardised yet. Review its mapping, then run "Standardise".';

export function createStagedService(
  repos: Pick<Repositories, 'sources' | 'stagedRecords'>,
): StagedService {
  return {
    async list(project, sourceId, { limit, cursor, issues }) {
      const source = await repos.sources.findById(project.id, sourceId);
      if (!source) throw AppError.notFound('Source not found.');
      const summary = source.standardisation;
      if (!summary) throw AppError.conflict(NOT_STANDARDISED, { reason: 'NOT_STANDARDISED' });
      // One extra row tells whether there is a next page.
      const rows = await repos.stagedRecords.list(project.id, sourceId, {
        runId: summary.runId,
        afterRow: cursor ?? 0,
        limit: limit + 1,
        issuesOnly: issues === 'only',
      });
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return {
        source: {
          id: source.id,
          name: source.name,
          status: source.status,
          standardisedAt: source.standardisedAt,
        },
        summary,
        items,
        nextCursor: rows.length > limit && last ? String(last.rowNumber) : null,
      };
    },
  };
}
