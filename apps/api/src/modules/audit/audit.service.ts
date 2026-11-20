import type { AuditRepository, NewAuditEntry } from './audit.types.js';

export type AuditInput = Omit<NewAuditEntry, 'actorType' | 'projectId' | 'before' | 'after'> &
  Partial<Pick<NewAuditEntry, 'actorType' | 'projectId' | 'before' | 'after'>>;

export interface AuditService {
  /** Records one entry. Callers must never pass passwords, tokens or raw record values. */
  record(input: AuditInput): Promise<void>;
}

export function createAuditService(repo: AuditRepository): AuditService {
  return {
    async record(input) {
      await repo.append({
        actorType: 'user',
        projectId: null,
        before: null,
        after: null,
        ...input,
      });
    },
  };
}
