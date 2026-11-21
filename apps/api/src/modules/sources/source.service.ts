import type { Request } from 'express';
import { Types } from 'mongoose';

import { AppError, DuplicateKeyError } from '../../errors.js';
import type { FieldError } from '../../middleware/validate.js';
import type { Repositories } from '../../repositories.js';
import { sourceFileKey } from '../../storage/keys.js';
import { StorageNotFoundError, type FileStorage } from '../../storage/storage.types.js';
import type { AuditService } from '../audit/audit.service.js';
import type { Project } from '../projects/project.types.js';
import type { Actor } from '../projects/project.service.js';

import { defaultSourceName } from './filename.js';
import type { ColumnProfile } from './column-profile.types.js';
import { fileTooComplex, sourceLimitReached } from './limits.js';
import { readPreview, type Preview } from './preview.js';
import { uploadFields } from './source.schemas.js';
import type { Source, SourcePatch } from './source.types.js';
import { receiveUpload } from './upload.js';
import { checkXlsx, XlsxTooComplexError, type XlsxLimits } from './xlsx-guard.js';

export interface SourceLimits {
  maxUploadBytes: number;
  maxUploadRows: number;
  maxSourcesPerProject: number;
  xlsx: XlsxLimits;
}

export interface SourceProfile {
  source: Source;
  /** In file order; empty until the source has been profiled. */
  columns: ColumnProfile[];
}

export interface SourceService {
  upload(actor: Actor, project: Project, req: Request): Promise<Source>;
  list(project: Project): Promise<Source[]>;
  get(project: Project, sourceId: string): Promise<Source>;
  update(actor: Actor, project: Project, sourceId: string, patch: SourcePatch): Promise<Source>;
  remove(actor: Actor, project: Project, sourceId: string): Promise<void>;
  preview(project: Project, sourceId: string, limit: number): Promise<Preview>;
  profile(project: Project, sourceId: string): Promise<SourceProfile>;
}

const SOURCE_GONE = 'Source not found.';
const DUPLICATE_FILE = 'This file is already in the project.';

/** Metadata only: never file contents or row values. */
function snapshot(source: Source): Record<string, unknown> {
  return {
    name: source.name,
    systemName: source.systemName,
    format: source.format,
    sizeBytes: source.sizeBytes,
    rowCount: source.rowCount,
    columnCount: source.columnCount,
  };
}

function parseUploadFields(fields: Record<string, string>) {
  const result = uploadFields.safeParse(fields);
  if (result.success) return result.data;
  const details: FieldError[] = result.error.issues.map((issue) => ({
    field: ['body', ...issue.path].join('.'),
    message: issue.message,
  }));
  throw AppError.validation('Some fields are invalid.', details);
}

export function createSourceService(
  repos: Pick<Repositories, 'sources' | 'columnProfiles' | 'mappings'>,
  storage: FileStorage,
  audit: AuditService,
  limits: SourceLimits,
): SourceService {
  function record(
    actor: Actor,
    source: Source,
    action: string,
    entry: { before?: Source; after?: Source },
  ): Promise<void> {
    return audit.record({
      projectId: source.projectId,
      actorId: actor.user.userId,
      action,
      entityType: 'source',
      entityId: source.id,
      before: entry.before ? snapshot(entry.before) : null,
      after: entry.after ? snapshot(entry.after) : null,
      requestId: actor.requestId,
    });
  }

  async function find(project: Project, sourceId: string): Promise<Source> {
    const source = await repos.sources.findById(project.id, sourceId);
    if (!source) throw AppError.notFound(SOURCE_GONE);
    return source;
  }

  async function open(source: Source) {
    try {
      return await storage.getStream(source.fileKey);
    } catch (error) {
      if (error instanceof StorageNotFoundError) {
        throw AppError.notFound(
          'The file for this source is missing. Delete the source and upload the file again.',
        );
      }
      throw error;
    }
  }

  /** A full pass over the workbook before exceljs reads it: no zip bomb reaches the parser. */
  async function assertSafeXlsx(source: Source): Promise<void> {
    try {
      await checkXlsx(await open(source), source.sizeBytes, limits.xlsx);
    } catch (error) {
      if (error instanceof XlsxTooComplexError) {
        throw fileTooComplex(limits.xlsx.maxUncompressedBytes);
      }
      if (error instanceof AppError) throw error;
      throw AppError.unsupportedFile('This Excel file could not be read.');
    }
  }

  async function assertRoomFor(project: Project): Promise<void> {
    if ((await repos.sources.countByProject(project.id)) >= limits.maxSourcesPerProject) {
      throw sourceLimitReached(limits.maxSourcesPerProject);
    }
  }

  return {
    async upload(actor, project, req) {
      // Checked before reading the body (fast answer) and again before saving (concurrent uploads).
      await assertRoomFor(project);
      const sourceId = new Types.ObjectId().toHexString();
      const received = await receiveUpload(req, {
        storage,
        maxBytes: limits.maxUploadBytes,
        maxRows: limits.maxUploadRows,
        keyFor: (format) => sourceFileKey(project.id, sourceId, format),
      });

      let created: Source | null = null;
      try {
        const fields = parseUploadFields(received.fields);
        if (await repos.sources.findBySha256(project.id, received.stored.sha256)) {
          throw AppError.conflict(DUPLICATE_FILE);
        }
        await assertRoomFor(project);
        created = await repos.sources.create({
          id: sourceId,
          projectId: project.id,
          name: fields.name ?? defaultSourceName(received.originalFilename),
          systemName: fields.systemName ?? null,
          originalFilename: received.originalFilename,
          fileKey: received.key,
          format: received.format,
          sizeBytes: received.stored.sizeBytes,
          sha256: received.stored.sha256,
          rowCount: received.inspection.rowCount,
          columnCount: received.inspection.columnCount,
          uploadedBy: actor.user.userId,
        });
        await record(actor, created, 'source.upload', { after: created });
        return created;
      } catch (error) {
        // No half-written state: remove the record (if saved) and the stored bytes.
        if (created) await repos.sources.delete(project.id, created.id);
        await storage.delete(received.key);
        if (error instanceof DuplicateKeyError) throw AppError.conflict(DUPLICATE_FILE);
        throw error;
      }
    },

    list(project) {
      return repos.sources.listByProject(project.id);
    },

    get: find,

    async update(actor, project, sourceId, patch) {
      const before = await find(project, sourceId);
      const updated = await repos.sources.update(project.id, sourceId, patch);
      if (!updated) throw AppError.notFound(SOURCE_GONE);
      await record(actor, updated, 'source.update', { before, after: updated });
      return updated;
    },

    async remove(actor, project, sourceId) {
      const source = await find(project, sourceId);
      // File first: if that fails the record remains and the delete can simply be retried.
      await storage.delete(source.fileKey);
      await repos.columnProfiles.deleteBySource(project.id, sourceId);
      await repos.mappings.deleteBySource(project.id, sourceId);
      if (!(await repos.sources.delete(project.id, sourceId))) {
        throw AppError.notFound(SOURCE_GONE);
      }
      await record(actor, source, 'source.delete', { before: source });
    },

    async preview(project, sourceId, limit) {
      const source = await find(project, sourceId);
      if (source.format === 'xlsx') await assertSafeXlsx(source);
      return readPreview(await open(source), source.format, limit);
    },

    async profile(project, sourceId) {
      const source = await find(project, sourceId);
      return { source, columns: await repos.columnProfiles.listBySource(project.id, sourceId) };
    },
  };
}

/** The API shape of a source: the internal storage key is not exposed. */
export function publicSource({ fileKey: _fileKey, ...source }: Source): Omit<Source, 'fileKey'> {
  return source;
}
