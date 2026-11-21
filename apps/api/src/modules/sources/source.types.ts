export const SOURCE_FORMATS = ['csv', 'xlsx'] as const;
export type SourceFormat = (typeof SOURCE_FORMATS)[number];

export const SOURCE_STATUSES = ['uploaded', 'profiling', 'ready', 'failed'] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

export interface SourceError {
  code: string;
  message: string;
}

/** One uploaded file in a project. Rows and values are never stored here, only metadata. */
export interface Source {
  id: string;
  projectId: string;
  name: string;
  systemName: string | null;
  /** Sanitised client filename, for display only. Never used to build a storage key. */
  originalFilename: string;
  /** Storage key (server-built). Internal: not returned by the API. */
  fileKey: string;
  format: SourceFormat;
  sizeBytes: number;
  sha256: string;
  status: SourceStatus;
  /** Data rows (header excluded). Set at upload for CSV; for XLSX by the profiler (M2.4). */
  rowCount: number | null;
  columnCount: number | null;
  error: SourceError | null;
  uploadedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export type NewSource = Omit<Source, 'status' | 'error' | 'createdAt' | 'updatedAt'>;

export interface SourcePatch {
  name?: string | undefined;
  /** `null` clears the system name. */
  systemName?: string | null | undefined;
}

export interface SourceRepository {
  /** Throws DuplicateKeyError when the project already has a source with the same sha256. */
  create(input: NewSource): Promise<Source>;
  /** Scoped to the project: a source id from another project is not found. */
  findById(projectId: string, id: string): Promise<Source | null>;
  findBySha256(projectId: string, sha256: string): Promise<Source | null>;
  /** Newest first. */
  listByProject(projectId: string): Promise<Source[]>;
  countByProject(projectId: string): Promise<number>;
  update(projectId: string, id: string, patch: SourcePatch): Promise<Source | null>;
  delete(projectId: string, id: string): Promise<boolean>;
  deleteByProject(projectId: string): Promise<number>;
}
