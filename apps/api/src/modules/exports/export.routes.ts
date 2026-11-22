import { pipeline } from 'node:stream/promises';

import { Router, type Request } from 'express';

import { sendData } from '../../http.js';
import { authenticate, currentUser } from '../../middleware/authenticate.js';
import { requestIdOf } from '../../middleware/request-id.js';
import { currentProject, requireProjectAccess } from '../../middleware/require-project-access.js';
import { validate, validated } from '../../middleware/validate.js';
import type { TokenService } from '../auth/tokens.js';
import type { Actor } from '../projects/project.service.js';
import type { ProjectRepository } from '../projects/project.types.js';

import { exportParams, exportsParams, listExportsQuery } from './export.schemas.js';
import type { ExportService } from './export.service.js';

export interface ExportRouterDeps {
  exportService: ExportService;
  projects: ProjectRepository;
  tokens: TokenService;
}

function actorOf(req: Request): Actor {
  return { user: currentUser(req), requestId: requestIdOf(req) };
}

/**
 * Mounted at /api/v1/projects/:projectId/exports (ADR 0020). Exports are started as `export`
 * jobs (POST .../jobs). Any member, viewers included, may list and download them (members may
 * see project data); owner, admin and data engineers may delete one. Every download is audited.
 */
export function createExportRouter({ exportService, projects, tokens }: ExportRouterDeps): Router {
  const router = Router({ mergeParams: true });
  const member = requireProjectAccess(projects, 'viewer', 'projectId');
  const engineer = requireProjectAccess(projects, 'data_engineer', 'projectId');

  router.use(authenticate(tokens));

  router.get(
    '/',
    validate({ params: exportsParams, query: listExportsQuery }),
    member,
    async (req, res) => {
      const { limit } = validated(req, 'query', listExportsQuery);
      sendData(res, { items: await exportService.list(currentProject(req), limit) });
    },
  );

  router.get('/:exportId', validate({ params: exportParams }), member, async (req, res) => {
    const { exportId } = validated(req, 'params', exportParams);
    sendData(res, { export: await exportService.get(currentProject(req), exportId) });
  });

  router.get(
    '/:exportId/download',
    validate({ params: exportParams }),
    member,
    async (req, res) => {
      const { exportId } = validated(req, 'params', exportParams);
      const download = await exportService.download(actorOf(req), currentProject(req), exportId);
      res.status(200);
      res.setHeader('Content-Type', download.contentType);
      res.setHeader('Content-Length', String(download.export.bytes));
      // The filename is built from ASCII letters, digits and "-" only, so it needs no escaping.
      res.setHeader('Content-Disposition', `attachment; filename="${download.export.filename}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      try {
        await pipeline(download.stream, res);
      } catch (error) {
        // Once bytes are on the way the status cannot change; the connection is closed instead.
        if (!res.headersSent) throw error;
      }
    },
  );

  router.delete('/:exportId', validate({ params: exportParams }), engineer, async (req, res) => {
    const { exportId } = validated(req, 'params', exportParams);
    await exportService.remove(actorOf(req), currentProject(req), exportId);
    sendData(res, { deleted: true });
  });

  return router;
}
