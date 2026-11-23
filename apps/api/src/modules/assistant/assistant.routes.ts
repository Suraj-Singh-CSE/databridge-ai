import { Router, type Request } from 'express';

import { sendData } from '../../http.js';
import { authenticate, currentUser } from '../../middleware/authenticate.js';
import { requestIdOf } from '../../middleware/request-id.js';
import { currentProject, requireProjectAccess } from '../../middleware/require-project-access.js';
import { validate, validated } from '../../middleware/validate.js';
import type { TokenService } from '../auth/tokens.js';
import type { Actor } from '../projects/project.service.js';
import type { ProjectRepository } from '../projects/project.types.js';

import {
  askBody,
  assistantParams,
  conversationParams,
  listConversationsQuery,
} from './assistant.schemas.js';
import type { AssistantService } from './assistant.service.js';

export interface AssistantRouterDeps {
  assistantService: AssistantService;
  projects: ProjectRepository;
  tokens: TokenService;
}

function actorOf(req: Request): Actor {
  return { user: currentUser(req), requestId: requestIdOf(req) };
}

/**
 * Mounted at /api/v1/projects/:projectId/assistant (ADR 0025). Any member may ask and sees
 * only their own conversations (anyone else's is 404). Owner, admin and data engineers may
 * read the usage counts. Questions are not audited (they are stored in the conversation);
 * deleting a conversation is.
 */
export function createAssistantRouter({
  assistantService,
  projects,
  tokens,
}: AssistantRouterDeps): Router {
  const router = Router({ mergeParams: true });
  const member = requireProjectAccess(projects, 'viewer', 'projectId');
  const engineer = requireProjectAccess(projects, 'data_engineer', 'projectId');

  router.use(authenticate(tokens));

  router.post(
    '/ask',
    validate({ params: assistantParams, body: askBody }),
    member,
    async (req, res) => {
      const body = validated(req, 'body', askBody);
      sendData(res, await assistantService.ask(actorOf(req), currentProject(req), body));
    },
  );

  router.get(
    '/conversations',
    validate({ params: assistantParams, query: listConversationsQuery }),
    member,
    async (req, res) => {
      const { limit } = validated(req, 'query', listConversationsQuery);
      const items = await assistantService.list(actorOf(req), currentProject(req), limit);
      sendData(res, { items });
    },
  );

  router.get(
    '/conversations/:conversationId',
    validate({ params: conversationParams }),
    member,
    async (req, res) => {
      const { conversationId } = validated(req, 'params', conversationParams);
      const conversation = await assistantService.get(
        actorOf(req),
        currentProject(req),
        conversationId,
      );
      sendData(res, { conversation });
    },
  );

  router.delete(
    '/conversations/:conversationId',
    validate({ params: conversationParams }),
    member,
    async (req, res) => {
      const { conversationId } = validated(req, 'params', conversationParams);
      await assistantService.remove(actorOf(req), currentProject(req), conversationId);
      sendData(res, { deleted: true });
    },
  );

  router.get('/usage', validate({ params: assistantParams }), engineer, async (req, res) => {
    sendData(res, { usage: await assistantService.usage(currentProject(req)) });
  });

  return router;
}
