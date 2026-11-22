export const EXPORT_FORMATS = ['csv', 'xlsx'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export const EXPORT_SCOPES = ['approved', 'all'] as const;
export type ExportScope = (typeof EXPORT_SCOPES)[number];

/**
 * One file of golden records written by the `export` job (apps/ai-service handlers/export.py).
 * The id is the job's id (one export per job, so a retried attempt replaces its own file). The
 * file lives in storage under `fileKey`; this record holds metadata only, never values.
 */
export interface ExportRecord {
  id: string;
  projectId: string;
  jobId: string;
  format: ExportFormat;
  scope: ExportScope;
  includeSources: boolean;
  rowCount: number;
  bytes: number;
  /** Lowercase hex SHA-256 of the file. */
  sha256: string;
  /** Built by the worker from server ids: `projects/<projectId>/exports/<id>.<format>`. */
  fileKey: string;
  clusteringRunId: string;
  schemaVersion: number | null;
  status: 'ready';
  createdBy: string | null;
  createdAt: Date;
}

export interface ExportRepository {
  /** Newest first. */
  listByProject(projectId: string, limit: number): Promise<ExportRecord[]>;
  findById(projectId: string, exportId: string): Promise<ExportRecord | null>;
  /** Returns whether a record was deleted. */
  delete(projectId: string, exportId: string): Promise<boolean>;
  deleteByProject(projectId: string): Promise<void>;
}
