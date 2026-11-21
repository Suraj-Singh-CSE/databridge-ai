import { AppError } from '../../errors.js';
import type { Repositories } from '../../repositories.js';
import type { AuditService } from '../audit/audit.service.js';
import type { Actor } from '../projects/project.service.js';
import type { Project } from '../projects/project.types.js';
import type { Source } from '../sources/source.types.js';
import type { TargetSchemaService } from '../target-schema/target-schema.service.js';
import type { TargetSchema } from '../target-schema/target-schema.types.js';

import type { DecideBody } from './mapping.schemas.js';
import type {
  MappingChoice,
  MappingDecision,
  MappingRun,
  MappingSuggestion,
  StoredSuggestion,
} from './mapping.types.js';

export type ColumnStatus = 'pending' | 'accepted' | 'rejected' | 'overridden';

export interface ColumnMapping {
  column: string;
  position: number;
  suggestion: MappingSuggestion;
  decision: MappingDecision | null;
  status: ColumnStatus;
}

export interface SourceMappings {
  source: Pick<Source, 'id' | 'name' | 'status'>;
  schemaVersion: number;
  /** The run behind the suggestions; null before the first mapping job. */
  run: MappingRun | null;
  /** True when the target schema changed after the suggestions were made. */
  stale: boolean;
  columns: ColumnMapping[];
  summary: { total: number; high: number; medium: number; low: number; decided: number };
}

export interface AcceptHighResult {
  accepted: number;
  /** Already decided before: left as they are. */
  alreadyDecided: number;
  /** Not accepted: the target is taken by another column or no longer in the schema. */
  conflicts: number;
}

export interface MappingService {
  list(project: Project, sourceId: string): Promise<SourceMappings>;
  decide(
    actor: Actor,
    project: Project,
    sourceId: string,
    column: string,
    body: DecideBody,
  ): Promise<ColumnMapping>;
  acceptHigh(actor: Actor, project: Project, sourceId: string): Promise<AcceptHighResult>;
}

const STATUS: Record<MappingDecision['decision'], ColumnStatus> = {
  accept: 'accepted',
  reject: 'rejected',
  override: 'overridden',
};

const REJECTED: MappingChoice = { target: null, role: 'ignore', transform: null };

function choiceOf(suggestion: MappingSuggestion): MappingChoice {
  return { target: suggestion.target, role: suggestion.role, transform: suggestion.transform };
}

function columnMapping(stored: StoredSuggestion, decision: MappingDecision | null): ColumnMapping {
  return {
    column: stored.column,
    position: stored.position,
    suggestion: stored.suggestion,
    decision,
    status: decision ? STATUS[decision.decision] : 'pending',
  };
}

/** The schema field a choice maps to, if it is still a mappable field of the schema. */
function mappableField(schema: TargetSchema, target: string) {
  const field = schema.fields.find((f) => f.name === target);
  return field && !field.generated ? field : null;
}

export function createMappingService(
  repos: Pick<Repositories, 'sources' | 'mappings'>,
  targetSchemas: TargetSchemaService,
  audit: AuditService,
): MappingService {
  async function findSource(project: Project, sourceId: string): Promise<Source> {
    const source = await repos.sources.findById(project.id, sourceId);
    if (!source) throw AppError.notFound('Source not found.');
    return source;
  }

  /** The column already accepted onto `target` (other than `column`), if any. */
  function holderOf(
    decisions: Iterable<MappingDecision>,
    target: string,
    column: string,
  ): string | null {
    for (const d of decisions) {
      if (d.column !== column && d.role === 'field' && d.target === target) return d.column;
    }
    return null;
  }

  function record(
    actor: Actor,
    project: Project,
    sourceId: string,
    action: string,
    entityId: string,
    after: Record<string, unknown>,
  ): Promise<void> {
    return audit.record({
      projectId: project.id,
      actorId: actor.user.userId,
      action,
      entityType: 'mapping',
      entityId,
      after: { sourceId, ...after },
      requestId: actor.requestId,
    });
  }

  return {
    async list(project, sourceId) {
      const source = await findSource(project, sourceId);
      const [schema, suggestions, decisions] = await Promise.all([
        targetSchemas.current(project),
        repos.mappings.listSuggestions(project.id, sourceId),
        repos.mappings.listDecisions(project.id, sourceId),
      ]);
      const byColumn = new Map(decisions.map((d) => [d.column, d]));
      const columns = suggestions.map((s) => columnMapping(s, byColumn.get(s.column) ?? null));
      const run = suggestions[0]?.run ?? null;
      const count = (label: string) =>
        columns.filter((c) => c.suggestion.confidenceLabel === label).length;
      return {
        source: { id: source.id, name: source.name, status: source.status },
        schemaVersion: schema.version,
        run,
        stale: run !== null && run.schemaVersion !== schema.version,
        columns,
        summary: {
          total: columns.length,
          high: count('High'),
          medium: count('Medium'),
          low: count('Low'),
          decided: columns.filter((c) => c.decision !== null).length,
        },
      };
    },

    async decide(actor, project, sourceId, column, body) {
      await findSource(project, sourceId);
      const suggestions = await repos.mappings.listSuggestions(project.id, sourceId);
      const stored = suggestions.find((s) => s.column === column);
      if (!stored) throw AppError.notFound('This column has no mapping suggestion.');
      const schema = await targetSchemas.current(project);

      let choice: MappingChoice;
      if (body.decision === 'accept') choice = choiceOf(stored.suggestion);
      else if (body.decision === 'reject') choice = REJECTED;
      else choice = { target: body.target, role: body.role, transform: body.transform };

      if (choice.role === 'field' && choice.target !== null) {
        const field = mappableField(schema, choice.target);
        if (!field && body.decision === 'override') {
          throw AppError.validation('Some fields are invalid.', [
            {
              field: 'body.target',
              message: 'must be a field of the target schema that is not generated',
            },
          ]);
        }
        if (!field) {
          throw AppError.conflict(
            `The suggested field "${choice.target}" is no longer in the target schema. ` +
              'Run the mapping again or choose a field yourself.',
          );
        }
        if (!field.allowConcat) {
          const decisions = await repos.mappings.listDecisions(project.id, sourceId);
          const holder = holderOf(decisions, field.name, column);
          if (holder) {
            throw AppError.conflict(
              `Column "${holder}" is already mapped to "${field.name}". ` +
                'Change that column first, or pick another field.',
            );
          }
        }
      }

      const decision: MappingDecision = {
        column,
        decision: body.decision,
        ...choice,
        schemaVersion: schema.version,
        decidedBy: actor.user.userId,
        decidedAt: new Date(),
      };
      await repos.mappings.saveDecision(project.id, sourceId, decision);
      await record(actor, project, sourceId, 'mapping.decide', `${sourceId}:${column}`, {
        column,
        decision: body.decision,
        ...choice,
      });
      return columnMapping(stored, decision);
    },

    async acceptHigh(actor, project, sourceId) {
      await findSource(project, sourceId);
      const [schema, suggestions, decisions] = await Promise.all([
        targetSchemas.current(project),
        repos.mappings.listSuggestions(project.id, sourceId),
        repos.mappings.listDecisions(project.id, sourceId),
      ]);
      const decided = new Map(decisions.map((d) => [d.column, d]));
      const result: AcceptHighResult = { accepted: 0, alreadyDecided: 0, conflicts: 0 };
      for (const stored of suggestions) {
        if (stored.suggestion.confidenceLabel !== 'High') continue;
        if (decided.has(stored.column)) {
          result.alreadyDecided += 1;
          continue;
        }
        const choice = choiceOf(stored.suggestion);
        if (choice.role === 'field' && choice.target !== null) {
          const field = mappableField(schema, choice.target);
          const taken =
            field && !field.allowConcat && holderOf(decided.values(), field.name, stored.column);
          if (!field || taken) {
            result.conflicts += 1;
            continue;
          }
        }
        const decision: MappingDecision = {
          column: stored.column,
          decision: 'accept',
          ...choice,
          schemaVersion: schema.version,
          decidedBy: actor.user.userId,
          decidedAt: new Date(),
        };
        await repos.mappings.saveDecision(project.id, sourceId, decision);
        decided.set(stored.column, decision);
        result.accepted += 1;
      }
      await record(actor, project, sourceId, 'mapping.accept_high', sourceId, { ...result });
      return result;
    },
  };
}
