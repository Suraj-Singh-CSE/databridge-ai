import { Router } from 'express';

import { sendData } from '../../http.js';
import { authenticate } from '../../middleware/authenticate.js';
import { currentProject, requireProjectAccess } from '../../middleware/require-project-access.js';
import { validate } from '../../middleware/validate.js';
import type { TokenService } from '../auth/tokens.js';
import type { ProjectRepository } from '../projects/project.types.js';

import { knowledgeParams } from './knowledge.schemas.js';
import type { KnowledgeRepository } from './knowledge.types.js';

export interface KnowledgeRouterDeps {
  knowledge: KnowledgeRepository;
  projects: ProjectRepository;
  tokens: TokenService;
}

/**
 * Mounted at /api/v1/projects/:projectId/knowledge (ADR 0024). Any member, viewers included,
 * may read the index summary; non-members get 404. `summary` is null until the first
 * `knowledge_index` job finishes. Searching the index comes with the assistant's answers.
 */
export function createKnowledgeRouter({
  knowledge,
  projects,
  tokens,
}: KnowledgeRouterDeps): Router {
  const router = Router({ mergeParams: true });
  const member = requireProjectAccess(projects, 'viewer', 'projectId');

  router.get(
    '/summary',
    authenticate(tokens),
    validate({ params: knowledgeParams }),
    member,
    async (req, res) => {
      const summary = await knowledge.findSummary(currentProject(req).id);
      sendData(res, { summary });
    },
  );

  return router;
}
