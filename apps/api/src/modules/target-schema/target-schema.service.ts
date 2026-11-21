import { AppError } from '../../errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { Actor } from '../projects/project.service.js';
import type { Project } from '../projects/project.types.js';

import { CUSTOMER_360 } from './default-schema.js';
import type {
  TargetSchema,
  TargetSchemaInput,
  TargetSchemaRepository,
} from './target-schema.types.js';

export interface TargetSchemaService {
  /** The project's schema; the Customer 360 default is stored on first use. */
  current(project: Project): Promise<TargetSchema>;
  /** Replaces the fields (new version). 409 when `baseVersion` is not the current one. */
  replace(
    actor: Actor,
    project: Project,
    input: TargetSchemaInput & { baseVersion?: number | undefined },
  ): Promise<TargetSchema>;
}

const STALE =
  'The target schema was changed by someone else. Reload it and apply your changes again.';

export function createTargetSchemaService(
  repo: TargetSchemaRepository,
  audit: AuditService,
): TargetSchemaService {
  async function current(project: Project): Promise<TargetSchema> {
    return (
      (await repo.findByProject(project.id)) ??
      (await repo.createIfMissing(project.id, CUSTOMER_360))
    );
  }

  return {
    current,

    async replace(actor, project, { baseVersion, ...input }) {
      const before = await current(project);
      if (baseVersion !== undefined && baseVersion !== before.version) {
        throw AppError.conflict(STALE);
      }
      const after = await repo.replace(project.id, before.version, input, actor.user.userId);
      if (!after) throw AppError.conflict(STALE);
      await audit.record({
        projectId: project.id,
        actorId: actor.user.userId,
        action: 'target_schema.replace',
        entityType: 'target_schema',
        entityId: project.id,
        before: { version: before.version, fields: before.fields.map((f) => f.name) },
        after: { version: after.version, fields: after.fields.map((f) => f.name) },
        requestId: actor.requestId,
      });
      return after;
    },
  };
}

/** The API shape (no internal ids). */
export function publicSchema(schema: TargetSchema) {
  return {
    name: schema.name,
    version: schema.version,
    fields: schema.fields,
    updatedBy: schema.updatedBy,
    updatedAt: schema.updatedAt,
  };
}
