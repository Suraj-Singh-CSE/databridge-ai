import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/logger.js';
import type { ExportRecord } from '../../src/modules/exports/export.types.js';
import type { QualityRun } from '../../src/modules/quality/quality.types.js';
import {
  createRetentionService,
  FREE_TIER_LIMIT_BYTES,
} from '../../src/modules/retention/retention.service.js';
import type { Repositories } from '../../src/repositories.js';
import type { LocalDiskStorage } from '../../src/storage/local-disk.storage.js';

import type { Harness } from './api-suite.js';
import { buildTestApp, TEST_BOOTSTRAP_ADMIN_EMAIL, tempStorage } from './build-app.js';

export interface RetentionHarness extends Harness {
  workerExport(repos: Repositories, record: ExportRecord): Promise<void>;
  workerQualityRun(repos: Repositories, run: QualityRun): Promise<void>;
}

interface Session {
  id: string;
  token: string;
}

const PASSWORD = 'correct horse battery';
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-26T12:00:00Z');
const bearer = (s: Session) => ({ Authorization: `Bearer ${s.token}` });
const newId = () => randomBytes(12).toString('hex');
const daysBefore = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

/** The retention sweep and the admin storage report (G3-11, ADR 0029), memory and MongoDB. */
export function defineRetentionSuite(label: string, harness: RetentionHarness): void {
  describe(`Data retention and storage report (${label})`, () => {
    let repos: Repositories;
    let storage: LocalDiskStorage;
    let app: Express;
    let admin: Session;
    let owner: Session;
    let projectId: string;

    async function register(email: string): Promise<Session> {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ email, name: 'User', password: PASSWORD })
        .expect(201);
      const body = res.body as { data: { user: { id: string }; accessToken: string } };
      return { id: body.data.user.id, token: body.data.accessToken };
    }

    function service(env: NodeJS.ProcessEnv = {}) {
      const config = loadConfig({ NODE_ENV: 'test', ...env });
      return createRetentionService(repos, storage, config, createLogger(config), () => NOW);
    }

    async function exported(createdAt: Date): Promise<ExportRecord> {
      const id = newId();
      const fileKey = `projects/${projectId}/exports/${id}.csv`;
      const stored = await storage.put(fileKey, Readable.from([Buffer.from('a,b\r\n')]), {
        contentType: 'text/csv',
      });
      const record: ExportRecord = {
        id,
        projectId,
        jobId: id,
        format: 'csv',
        scope: 'approved',
        includeSources: false,
        rowCount: 1,
        bytes: stored.sizeBytes,
        sha256: stored.sha256,
        fileKey,
        clusteringRunId: 'job:1',
        schemaVersion: 1,
        status: 'ready',
        createdBy: owner.id,
        createdAt,
      };
      await harness.workerExport(repos, record);
      return record;
    }

    async function reported(startedAt: Date): Promise<string> {
      const id = newId();
      await harness.workerQualityRun(repos, {
        id,
        projectId,
        jobId: id,
        startedAt,
        finishedAt: startedAt,
        source: {
          kind: 'golden_records',
          label: 'Golden records',
          versionId: null,
          version: null,
          scope: 'approved',
          sqlTestsPassed: true,
          failedChecks: [],
        },
        clusteringRunId: 'job:1',
        schemaVersion: 1,
        rowCount: 0,
        status: 'pass',
        statusCounts: { pass: 0, warn: 0, fail: 0, skipped: 0 },
        ruleCount: 0,
        results: [],
        config: {},
        createdBy: owner.id,
      });
      return id;
    }

    beforeEach(async () => {
      repos = await harness.setup();
      storage = tempStorage();
      app = buildTestApp({ repos, storage });
      admin = await register(TEST_BOOTSTRAP_ADMIN_EMAIL);
      owner = await register('owner@example.com');
      const res = await request(app)
        .post('/api/v1/projects')
        .set(bearer(owner))
        .send({ name: 'Retention' })
        .expect(201);
      projectId = (res.body as { data: { project: { id: string } } }).data.project.id;
    });

    describe('GET /admin/storage', () => {
      it('shows collection sizes and the retention settings to an admin', async () => {
        const res = await request(app).get('/api/v1/admin/storage').set(bearer(admin));

        expect(res.status).toBe(200);
        const data = res.body.data as {
          collections: { name: string; documents: number }[];
          limitBytes: number;
          retention: Record<string, number>;
        };
        expect(data.limitBytes).toBe(FREE_TIER_LIMIT_BYTES);
        expect(data.retention).toEqual({
          jobsDays: 30,
          llmCallsDays: 30,
          assistantDays: 30,
          exportsDays: 30,
          qualityRunsDays: 90,
          auditMaxEntriesPerProject: 20_000,
        });
        expect(data.collections.find((c) => c.name === 'users')?.documents).toBe(2);
      });

      it('refuses everyone else: 403 for a non-admin, 401 without a token', async () => {
        const forbidden = await request(app).get('/api/v1/admin/storage').set(bearer(owner));
        expect(forbidden.status).toBe(403);
        expect(forbidden.body.error.code).toBe('FORBIDDEN');
        const anonymous = await request(app).get('/api/v1/admin/storage');
        expect(anonymous.status).toBe(401);
      });
    });

    describe('sweep', () => {
      it('deletes exports past their retention, file first, and keeps newer ones', async () => {
        const old = await exported(daysBefore(31));
        const recent = await exported(daysBefore(2));

        const result = await service().sweep();

        expect(result.exports).toBe(1);
        expect(await repos.exports.findById(projectId, old.id)).toBeNull();
        expect(await storage.exists(old.fileKey)).toBe(false);
        expect(await repos.exports.findById(projectId, recent.id)).not.toBeNull();
        expect(await storage.exists(recent.fileKey)).toBe(true);
      });

      it('deletes old quality reports but always keeps the newest one', async () => {
        const oldest = await reported(daysBefore(200));
        const older = await reported(daysBefore(120));
        const newest = await reported(daysBefore(100));

        const result = await service().sweep();

        expect(result.qualityRuns).toBe(2);
        expect(await repos.quality.findRun(projectId, oldest)).toBeNull();
        expect(await repos.quality.findRun(projectId, older)).toBeNull();
        expect((await repos.quality.latestRun(projectId))?.id).toBe(newest);
      });

      it('caps the audit log at the newest N entries per project', async () => {
        const before = (await repos.audit.listByProject(projectId, { skip: 0, limit: 100 })).total;
        for (let i = 0; i < 8; i += 1) {
          await repos.audit.append({
            projectId,
            actorType: 'user',
            actorId: owner.id,
            action: `test.step_${String(i)}`,
            entityType: 'project',
            entityId: projectId,
            before: null,
            after: null,
            requestId: `req-${String(i)}`,
          });
          await new Promise((resolve) => setTimeout(resolve, 2));
        }

        const result = await service({ AUDIT_MAX_ENTRIES_PER_PROJECT: '5' }).sweep();

        expect(result.auditEntries).toBe(before + 3);
        const kept = await repos.audit.listByProject(projectId, { skip: 0, limit: 100 });
        expect(kept.total).toBe(5);
        expect(kept.items.map((e) => e.action)).toEqual([
          'test.step_7',
          'test.step_6',
          'test.step_5',
          'test.step_4',
          'test.step_3',
        ]);
      });
    });
  });
}
