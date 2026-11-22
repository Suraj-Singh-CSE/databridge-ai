/**
 * Column mapping: what the ai-service suggests for each column of a source
 * (`mapping_suggestions`, written by apps/ai-service/app/mapping/store.py) and what a reviewer
 * decided (`mapping_decisions`, owned by the api). See docs/adr/0012-column-mapping.md.
 */
export const MAPPING_ROLES = ['field', 'source_record_id', 'ignore'] as const;
export type MappingRole = (typeof MAPPING_ROLES)[number];

export const CONFIDENCE_LABELS = ['High', 'Medium', 'Low'] as const;
export type ConfidenceLabel = (typeof CONFIDENCE_LABELS)[number];

export const MAPPING_METHODS = ['hybrid', 'rules'] as const;
export type MappingMethod = (typeof MAPPING_METHODS)[number];

export const DECISIONS = ['accept', 'reject', 'override'] as const;
export type Decision = (typeof DECISIONS)[number];

export interface MappingAlternative {
  target: string | null;
  role: MappingRole;
  confidence: number;
}

/** The engine's proposal for one column. `target` is null unless `role` is `field`. */
export interface MappingSuggestion {
  target: string | null;
  role: MappingRole;
  /** 0-1. */
  confidence: number;
  confidenceLabel: ConfidenceLabel;
  /** Plain-language explanation for the reviewer. */
  reason: string;
  /** Hint for the cleaning step, e.g. `to_e164_in`, `parse_date:DD/MM/YYYY`. */
  transform: string | null;
  alternatives: MappingAlternative[];
}

/** The run that produced a suggestion. */
export interface MappingRun {
  jobId: string;
  runId: string;
  schemaVersion: number;
  /** `rules` when the LLM step failed or was off and only the deterministic rules were used. */
  method: MappingMethod;
  model: string | null;
  createdAt: Date;
}

export interface StoredSuggestion {
  column: string;
  /** 0-based position in the file. */
  position: number;
  suggestion: MappingSuggestion;
  run: MappingRun;
}

/** What gets used: the accepted suggestion, an override, or nothing (rejected). */
export interface MappingChoice {
  target: string | null;
  role: MappingRole;
  transform: string | null;
}

/**
 * For `accept`, the choice fields are a snapshot of the suggestion as accepted; standardise
 * refuses the accept once a mapping re-run changed that suggestion (ADR 0014).
 */
export interface MappingDecision extends MappingChoice {
  column: string;
  decision: Decision;
  /** Target schema version the decision was checked against. */
  schemaVersion: number;
  decidedBy: string;
  decidedAt: Date;
}

export interface MappingRepository {
  /** In file order; empty until a mapping job has run. */
  listSuggestions(projectId: string, sourceId: string): Promise<StoredSuggestion[]>;
  listDecisions(projectId: string, sourceId: string): Promise<MappingDecision[]>;
  /** Insert or replace the decision for `decision.column`. */
  saveDecision(projectId: string, sourceId: string, decision: MappingDecision): Promise<void>;
  deleteBySource(projectId: string, sourceId: string): Promise<void>;
  deleteByProject(projectId: string): Promise<void>;
}
