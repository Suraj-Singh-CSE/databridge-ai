import type { Page, PageRequest } from '../../http.js';

export type ActorType = 'user' | 'ai';
export type Snapshot = Record<string, unknown>;

export interface NewAuditEntry {
  projectId: string | null;
  actorType: ActorType;
  actorId: string;
  /** Dotted verb, e.g. "project.create", "auth.login". */
  action: string;
  entityType: string;
  entityId: string;
  before: Snapshot | null;
  after: Snapshot | null;
  requestId: string;
}

export interface AuditEntry extends NewAuditEntry {
  id: string;
  createdAt: Date;
}

/** Append-only by design: there is deliberately no update or delete method. */
export interface AuditRepository {
  append(entry: NewAuditEntry): Promise<AuditEntry>;
  listByProject(projectId: string, page: PageRequest): Promise<Omit<Page<AuditEntry>, 'page'>>;
}
