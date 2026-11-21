/**
 * The target schema of a project: the fields of the clean dataset that source columns are mapped
 * onto. One per project, versioned: every replace bumps `version`, and mapping suggestions record
 * the version they were made for. Field names are shared with apps/ai-service/app/mapping.
 */
export const FIELD_TYPES = ['string', 'integer', 'decimal', 'boolean', 'date', 'datetime'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface TargetField {
  /** snake_case, unique within the schema. */
  name: string;
  type: FieldType;
  /** Expected format in plain words, e.g. "YYYY-MM-DD". */
  format: string | null;
  description: string;
  isPii: boolean;
  /** Created by DataBridge (e.g. customer_id); never mapped from a source column. */
  generated: boolean;
  required: boolean;
  /** Several columns of one source may fill it together (first + last name, address lines). */
  allowConcat: boolean;
}

export interface TargetSchema {
  projectId: string;
  name: string;
  version: number;
  fields: TargetField[];
  /** Null for the default schema seeded by DataBridge. */
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TargetSchemaInput {
  name: string;
  fields: TargetField[];
}

export interface TargetSchemaRepository {
  findByProject(projectId: string): Promise<TargetSchema | null>;
  /** Inserts version 1 unless the project already has a schema; returns the stored one. */
  createIfMissing(projectId: string, input: TargetSchemaInput): Promise<TargetSchema>;
  /**
   * Replaces the fields and bumps the version, only while the stored version is
   * `expectedVersion`. Returns null when it is not (someone else changed it meanwhile).
   */
  replace(
    projectId: string,
    expectedVersion: number,
    input: TargetSchemaInput,
    updatedBy: string,
  ): Promise<TargetSchema | null>;
  deleteByProject(projectId: string): Promise<number>;
}
