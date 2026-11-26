import { Router } from 'express';

import { sendData } from '../../http.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requireRole } from '../../middleware/require-role.js';
import type { TokenService } from '../auth/tokens.js';

import type { RetentionService } from './retention.service.js';

export interface AdminRouterDeps {
  retention: RetentionService;
  tokens: TokenService;
}

/**
 * Mounted at /api/v1/admin (ADR 0029). Admins only: approximate size of every collection
 * against the 512 MB free-tier limit, and the retention settings in force.
 */
export function createAdminRouter({ retention, tokens }: AdminRouterDeps): Router {
  const router = Router();

  router.get('/storage', authenticate(tokens), requireRole('admin'), async (_req, res) => {
    sendData(res, await retention.report());
  });

  return router;
}
