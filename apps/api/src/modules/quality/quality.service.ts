import { AppError } from '../../errors.js';
import { toPageRequest, type Page } from '../../http.js';
import type { Repositories } from '../../repositories.js';
import type { AuditService } from '../audit/audit.service.js';
import type { Actor } from '../projects/project.service.js';
import type { Project } from '../projects/project.types.js';

import {
  QUALITY_RULES,
  type QualityRuleOverrides,
  type QualityRules,
  type QualityRun,
  type QualityRunSummary,
} from './quality.types.js';

/** The rule settings as the UI needs them: the project's overrides and what can be set. */
export interface QualityRulesView extends QualityRules {
  catalogue: { rule: string; direction: 'min' | 'max'; max: number }[];
}

export interface QualityService {
  listRuns(project: Project, page: number, limit: number): Promise<Page<QualityRunSummary>>;
  getRun(project: Project, runId: string): Promise<QualityRun>;
  /** The newest report, or null before the first quality check. */
  latest(project: Project): Promise<QualityRun | null>;
  rules(project: Project): Promise<QualityRulesView>;
  /** Replaces the overrides (validated by the route); audited with before and after. */
  saveRules(
    actor: Actor,
    project: Project,
    overrides: QualityRuleOverrides,
  ): Promise<QualityRulesView>;
}

export const QUALITY_RUN_NOT_FOUND = 'Quality report not found.';
const CATALOGUE = Object.entries(QUALITY_RULES).map(([rule, spec]) => ({ rule, ...spec }));
const EMPTY: QualityRules = { rules: {}, fields: {}, updatedBy: null, updatedAt: null };

type QualityRepos = Pick<Repositories, 'quality'>;

export function createQualityService(
  repos: QualityRepos,
  audit: AuditService,
  now: () => Date = () => new Date(),
): QualityService {
  const view = (rules: QualityRules): QualityRulesView => ({ ...rules, catalogue: CATALOGUE });

  return {
    async listRuns(project, page, limit) {
      const result = await repos.quality.listRuns(project.id, toPageRequest(page, limit));
      return { ...result, page, limit };
    },

    async getRun(project, runId) {
      const run = await repos.quality.findRun(project.id, runId);
      if (!run) throw AppError.notFound(QUALITY_RUN_NOT_FOUND);
      return run;
    },

    latest(project) {
      return repos.quality.latestRun(project.id);
    },

    async rules(project) {
      return view((await repos.quality.findRules(project.id)) ?? EMPTY);
    },

    async saveRules(actor, project, overrides) {
      const before = await repos.quality.findRules(project.id);
      const saved = await repos.quality.saveRules(project.id, overrides, actor.user.userId, now());
      await audit.record({
        projectId: project.id,
        actorId: actor.user.userId,
        action: 'quality_rules.update',
        entityType: 'quality_rules',
        entityId: project.id,
        // null: the project used the defaults until now.
        before: before ? { rules: before.rules, fields: before.fields } : null,
        after: { rules: saved.rules, fields: saved.fields },
        requestId: actor.requestId,
      });
      return view(saved);
    },
  };
}
