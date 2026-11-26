import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import express, { Router } from 'express';

const API_PREFIX = '/api/';
const ONE_YEAR_SECONDS = 31_536_000;

export class WebDistError extends Error {
  override readonly name = 'WebDistError';
}

/** True for /api and anything under it: those paths always get the JSON API (and its 404). */
function isApiPath(urlPath: string): boolean {
  return urlPath === '/api' || urlPath.startsWith(API_PREFIX);
}

/**
 * Serves the built web app (Vite `dist`) from the api, so the browser and the API share one
 * origin and the SameSite=Strict refresh cookie is sent (ADR 0027).
 *
 * - `/assets/*` (content-hashed by Vite): cached for a year, `immutable`; a missing asset is a
 *   plain 404, never index.html (a stale page must not run HTML as a script).
 * - Other files in `dist` (e.g. a favicon): `no-cache`, so a deploy is picked up at once.
 * - Any other GET/HEAD outside `/api`: index.html (`no-cache`) for client-side routes.
 */
export function createWebRouter(distDir: string): Router {
  const root = path.resolve(distDir);
  const indexPath = path.join(root, 'index.html');
  if (!existsSync(indexPath)) {
    throw new WebDistError(
      `SERVE_WEB=true but ${indexPath} does not exist. Build the web app ` +
        '(npm run build --workspace apps/web) or set WEB_DIST_DIR.',
    );
  }
  const indexHtml = readFileSync(indexPath);
  const router = Router();

  router.use(
    '/assets',
    express.static(path.join(root, 'assets'), {
      index: false,
      fallthrough: true,
      immutable: true,
      maxAge: ONE_YEAR_SECONDS * 1000,
    }),
    (_req, res) => {
      res.status(404).type('text/plain').send('Not found');
    },
  );

  const otherFiles = express.static(root, {
    index: false,
    fallthrough: true,
    setHeaders: (response) => {
      response.setHeader('Cache-Control', 'no-cache');
    },
  });
  router.use((req, res, next) => {
    if (isApiPath(req.path)) {
      next();
      return;
    }
    otherFiles(req, res, next);
  });

  router.use((req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || isApiPath(req.path)) {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(indexHtml);
  });

  return router;
}
