import type { Readable } from 'node:stream';

import { AppError } from '../../errors.js';
import type { Repositories } from '../../repositories.js';
import { exportFileKey } from '../../storage/keys.js';
import { StorageNotFoundError, type FileStorage } from '../../storage/storage.types.js';
import type { AuditService } from '../audit/audit.service.js';
import type { Actor } from '../projects/project.service.js';
import type { Project } from '../projects/project.types.js';

import type { ExportFormat, ExportRecord } from './export.types.js';

/** What the API shows of an export: its metadata and download name, not the storage key. */
export type ExportView = Omit<ExportRecord, 'fileKey'> & { filename: string };

export interface ExportDownload {
  export: ExportView;
  contentType: string;
  stream: Readable;
}

export interface ExportService {
  list(project: Project, limit: number): Promise<ExportView[]>;
  get(project: Project, exportId: string): Promise<ExportView>;
  /** Audited (`export.download`) before the file starts streaming. */
  download(actor: Actor, project: Project, exportId: string): Promise<ExportDownload>;
  remove(actor: Actor, project: Project, exportId: string): Promise<void>;
}

export const EXPORT_NOT_FOUND = 'Export not found.';
export const EXPORT_FILE_GONE =
  'The file of this export is no longer available. Start a new export.';

export const CONTENT_TYPES: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Lower-case ASCII letters and digits joined by "-", at most 40 characters. */
export function projectSlug(name: string): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'project';
}

/** `customers-<project-slug>-<yyyymmdd-hhmm>.<ext>` (UTC): safe ASCII, no quotes or slashes. */
export function exportFilename(projectName: string, createdAt: Date, format: ExportFormat): string {
  const stamp = createdAt.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
  return `customers-${projectSlug(projectName)}-${stamp}.${format}`;
}

type ExportRepos = Pick<Repositories, 'exports'>;

export function createExportService(
  repos: ExportRepos,
  storage: FileStorage,
  audit: AuditService,
): ExportService {
  function view(project: Project, record: ExportRecord): ExportView {
    const { fileKey: _key, ...rest } = record;
    return { ...rest, filename: exportFilename(project.name, record.createdAt, record.format) };
  }

  async function find(project: Project, exportId: string): Promise<ExportRecord> {
    const record = await repos.exports.findById(project.id, exportId);
    if (!record) throw AppError.notFound(EXPORT_NOT_FOUND);
    return record;
  }

  /** Built here from validated ids, never taken from the stored document. */
  const keyOf = (project: Project, record: ExportRecord) =>
    exportFileKey(project.id, record.id, record.format);

  const summary = (record: ExportRecord) => ({
    format: record.format,
    scope: record.scope,
    includeSources: record.includeSources,
    rowCount: record.rowCount,
    bytes: record.bytes,
    sha256: record.sha256,
    clusteringRunId: record.clusteringRunId,
  });

  return {
    async list(project, limit) {
      const records = await repos.exports.listByProject(project.id, limit);
      return records.map((record) => view(project, record));
    },

    async get(project, exportId) {
      return view(project, await find(project, exportId));
    },

    async download(actor, project, exportId) {
      const record = await find(project, exportId);
      let stream: Readable;
      try {
        stream = await storage.getStream(keyOf(project, record));
      } catch (error) {
        if (error instanceof StorageNotFoundError) throw AppError.notFound(EXPORT_FILE_GONE);
        throw error;
      }
      try {
        await audit.record({
          projectId: project.id,
          actorId: actor.user.userId,
          action: 'export.download',
          entityType: 'export',
          entityId: record.id,
          after: summary(record),
          requestId: actor.requestId,
        });
      } catch (error) {
        stream.destroy();
        throw error;
      }
      return { export: view(project, record), contentType: CONTENT_TYPES[record.format], stream };
    },

    async remove(actor, project, exportId) {
      const record = await find(project, exportId);
      await storage.delete(keyOf(project, record));
      await repos.exports.delete(project.id, record.id);
      await audit.record({
        projectId: project.id,
        actorId: actor.user.userId,
        action: 'export.delete',
        entityType: 'export',
        entityId: record.id,
        before: summary(record),
        requestId: actor.requestId,
      });
    },
  };
}
