import { randomBytes } from 'node:crypto';

import { DuplicateKeyError } from '../../src/errors.js';
import type { AuditEntry } from '../../src/modules/audit/audit.types.js';
import type {
  CandidatePair,
  CandidateRepository,
  CandidateSummary,
} from '../../src/modules/candidates/candidate.types.js';
import type { Job, JobRepository } from '../../src/modules/jobs/job.types.js';
import type {
  MappingDecision,
  MappingRepository,
  StoredSuggestion,
} from '../../src/modules/mappings/mapping.types.js';
import type { RefreshTokenRecord } from '../../src/modules/auth/refresh-token.types.js';
import type { Project } from '../../src/modules/projects/project.types.js';
import type {
  PairScore,
  ScoreRepository,
  ScoreSummary,
} from '../../src/modules/scores/score.types.js';
import type {
  ColumnProfile,
  ColumnProfileRepository,
} from '../../src/modules/sources/column-profile.types.js';
import type { Source } from '../../src/modules/sources/source.types.js';
import type {
  StagedRecord,
  StagedRecordRef,
  StagedRecordRepository,
} from '../../src/modules/staged/staged.types.js';
import type { TargetSchema } from '../../src/modules/target-schema/target-schema.types.js';
import type { User } from '../../src/modules/users/user.types.js';
import type { Repositories } from '../../src/repositories.js';

/** 24-hex ids, like MongoDB ObjectIds, so the same route validation applies. */
const newId = () => randomBytes(12).toString('hex');

/** Ever-increasing timestamps so "newest first" ordering is deterministic. */
let clock = Date.now();
const tick = () => new Date((clock += 1));

/** A worker's direct write to a job (the Python worker writes MongoDB itself). */
export type WorkerPatch = Partial<
  Pick<Job, 'status' | 'progress' | 'message' | 'result' | 'error' | 'attempts'>
> & { startedAt?: Date | null; heartbeatAt?: Date | null; finishedAt?: Date | null };

/** What the Python profiler writes: column profiles plus the source summary. */
export interface ProfileWrite {
  projectId: string;
  sourceId: string;
  columns: ColumnProfile[];
  source: Partial<Pick<Source, 'status' | 'rowCount' | 'columnCount' | 'profiledAt' | 'error'>>;
}

/** What the Python mapping worker writes: one suggestion per column of a source. */
export interface SuggestionWrite {
  projectId: string;
  sourceId: string;
  suggestions: StoredSuggestion[];
}

/** What the Python standardise worker writes: one run's rows plus the source summary. */
export interface StagedWrite {
  projectId: string;
  sourceId: string;
  runId: string;
  /** `id` (the staged record's id) is optional; one is made when absent. */
  rows: (StagedRecord & { id?: string })[];
  source: Partial<Pick<Source, 'status' | 'standardisedAt' | 'standardisation'>>;
}

/** What the Python candidates worker writes: one run's pairs plus the project summary. */
export interface CandidateWrite {
  projectId: string;
  pairs: CandidatePair[];
  summary: CandidateSummary;
}

/** What the Python scoring worker writes: one run's scores plus the project summary. */
export interface ScoreWrite {
  projectId: string;
  scores: PairScore[];
  summary: ScoreSummary;
}

export interface MemoryRepositories extends Repositories {
  jobs: JobRepository & { workerUpdate(id: string, patch: WorkerPatch): void };
  columnProfiles: ColumnProfileRepository & { workerSave(write: ProfileWrite): void };
  mappings: MappingRepository & { workerSave(write: SuggestionWrite): void };
  stagedRecords: StagedRecordRepository & { workerSave(write: StagedWrite): void };
  candidates: CandidateRepository & { workerSave(write: CandidateWrite): void };
  scores: ScoreRepository & { workerSave(write: ScoreWrite): void };
}

/**
 * In-memory implementations of every repository with the same contract as the Mongo ones.
 * Used to run the full API suite without a database; the same suite also runs against MongoDB.
 */
export function createMemoryRepositories(): MemoryRepositories {
  const users = new Map<string, User & { passwordHash: string }>();
  const tokens = new Map<string, RefreshTokenRecord>();
  const projects = new Map<string, Project>();
  const sources = new Map<string, Source>();
  // key: `${projectId}/${sourceId}`
  const profiles = new Map<string, ColumnProfile[]>();
  const jobs = new Map<string, Job>();
  const schemas = new Map<string, TargetSchema>();
  // key: `${projectId}/${sourceId}`
  const suggestions = new Map<string, StoredSuggestion[]>();
  const decisions = new Map<string, Map<string, MappingDecision>>();
  // key: `${projectId}/${sourceId}`; one run per source (the worker drops older runs).
  const staged = new Map<string, { runId: string; rows: StagedRecordRef[] }>();
  // key: projectId; one run per project (the worker drops older runs).
  const candidates = new Map<string, { summary: CandidateSummary; pairs: CandidatePair[] }>();
  // key: projectId; one run per project (the worker drops older runs).
  const scores = new Map<string, { summary: ScoreSummary; scores: PairScore[] }>();
  const dropPrefix = (map: Map<string, unknown>, projectId: string) => {
    for (const key of map.keys()) if (key.startsWith(`${projectId}/`)) map.delete(key);
  };
  const audit: AuditEntry[] = [];
  let firstAdminClaimed = false;

  const publicUser = ({ passwordHash: _hash, ...user }: User & { passwordHash: string }): User =>
    structuredClone(user);
  const byEmail = (email: string) => [...users.values()].find((u) => u.email === email);
  const clone = (project: Project | undefined) => (project ? structuredClone(project) : null);

  return {
    users: {
      async create(input) {
        await Promise.resolve();
        if (byEmail(input.email)) throw new DuplicateKeyError('email already registered');
        const at = tick();
        const user = { id: newId(), ...input, createdAt: at, updatedAt: at };
        users.set(user.id, user);
        return publicUser(user);
      },
      async findById(id) {
        await Promise.resolve();
        const user = users.get(id);
        return user ? publicUser(user) : null;
      },
      async findByEmail(email) {
        await Promise.resolve();
        const user = byEmail(email);
        return user ? publicUser(user) : null;
      },
      async findCredentialsByEmail(email) {
        await Promise.resolve();
        const user = byEmail(email);
        return user ? { user: publicUser(user), passwordHash: user.passwordHash } : null;
      },
      async count() {
        await Promise.resolve();
        return users.size;
      },
      async claimFirstAdmin() {
        await Promise.resolve();
        if (firstAdminClaimed) return false;
        firstAdminClaimed = true;
        return true;
      },
    },

    refreshTokens: {
      async create(input) {
        await Promise.resolve();
        const record: RefreshTokenRecord = {
          id: newId(),
          ...input,
          revokedAt: null,
          replacedBy: null,
          reuseDetectedAt: null,
          createdAt: tick(),
        };
        tokens.set(record.id, record);
        return { ...record };
      },
      async findByHash(tokenHash) {
        await Promise.resolve();
        const record = [...tokens.values()].find((t) => t.tokenHash === tokenHash);
        return record ? { ...record } : null;
      },
      async revoke(id, at) {
        await Promise.resolve();
        const record = tokens.get(id);
        if (!record || record.revokedAt) return false;
        record.revokedAt = at;
        return true;
      },
      async setReplacedBy(id, replacedBy) {
        await Promise.resolve();
        const record = tokens.get(id);
        if (record) record.replacedBy = replacedBy;
      },
      async revokeFamily(familyId, at) {
        await Promise.resolve();
        for (const record of tokens.values()) {
          if (record.familyId !== familyId) continue;
          record.reuseDetectedAt = at;
          record.revokedAt ??= at;
        }
      },
      async isFamilyCompromised(familyId) {
        await Promise.resolve();
        return [...tokens.values()].some((t) => t.familyId === familyId && t.reuseDetectedAt);
      },
    },

    projects: {
      async create(input) {
        await Promise.resolve();
        const at = tick();
        const project: Project = {
          id: newId(),
          ...input,
          status: 'active',
          currentStep: 'sources',
          createdAt: at,
          updatedAt: at,
        };
        projects.set(project.id, project);
        return structuredClone(project);
      },
      async findById(id) {
        await Promise.resolve();
        return clone(projects.get(id));
      },
      async list(visibleTo, { skip, limit }) {
        await Promise.resolve();
        const visible = [...projects.values()]
          .filter(
            (p) =>
              visibleTo === null ||
              p.ownerId === visibleTo ||
              p.members.some((m) => m.userId === visibleTo),
          )
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
        return {
          items: visible.slice(skip, skip + limit).map((p) => structuredClone(p)),
          limit,
          total: visible.length,
        };
      },
      async update(id, patch) {
        await Promise.resolve();
        const project = projects.get(id);
        if (!project) return null;
        const defined = Object.entries(patch).filter(([, value]) => value !== undefined);
        Object.assign(project, Object.fromEntries(defined) as Partial<Project>);
        project.updatedAt = tick();
        return clone(project);
      },
      async delete(id) {
        await Promise.resolve();
        return projects.delete(id);
      },
      async addMember(id, member) {
        await Promise.resolve();
        const project = projects.get(id);
        if (!project || project.members.some((m) => m.userId === member.userId)) return null;
        project.members.push({ ...member });
        project.updatedAt = tick();
        return clone(project);
      },
      async removeMember(id, userId) {
        await Promise.resolve();
        const project = projects.get(id);
        if (!project) return null;
        project.members = project.members.filter((m) => m.userId !== userId);
        project.updatedAt = tick();
        return clone(project);
      },
    },

    sources: {
      async create(input) {
        await Promise.resolve();
        const taken = [...sources.values()].some(
          (s) => s.projectId === input.projectId && s.sha256 === input.sha256,
        );
        if (taken) throw new DuplicateKeyError('file already in project');
        const at = tick();
        const source: Source = {
          ...input,
          status: 'uploaded',
          error: null,
          profiledAt: null,
          standardisedAt: null,
          standardisation: null,
          createdAt: at,
          updatedAt: at,
        };
        sources.set(source.id, source);
        return structuredClone(source);
      },
      async findById(projectId, id) {
        await Promise.resolve();
        const source = sources.get(id);
        return source?.projectId === projectId ? structuredClone(source) : null;
      },
      async findBySha256(projectId, sha256) {
        await Promise.resolve();
        const source = [...sources.values()].find(
          (s) => s.projectId === projectId && s.sha256 === sha256,
        );
        return source ? structuredClone(source) : null;
      },
      async listByProject(projectId) {
        await Promise.resolve();
        return [...sources.values()]
          .filter((s) => s.projectId === projectId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map((s) => structuredClone(s));
      },
      async countByProject(projectId) {
        await Promise.resolve();
        return [...sources.values()].filter((s) => s.projectId === projectId).length;
      },
      async update(projectId, id, patch) {
        await Promise.resolve();
        const source = sources.get(id);
        if (source?.projectId !== projectId) return null;
        const defined = Object.entries(patch).filter(([, value]) => value !== undefined);
        Object.assign(source, Object.fromEntries(defined) as Partial<Source>);
        source.updatedAt = tick();
        return structuredClone(source);
      },
      async delete(projectId, id) {
        await Promise.resolve();
        if (sources.get(id)?.projectId !== projectId) return false;
        return sources.delete(id);
      },
      async deleteByProject(projectId) {
        await Promise.resolve();
        let deleted = 0;
        for (const [id, source] of sources) {
          if (source.projectId !== projectId) continue;
          sources.delete(id);
          deleted += 1;
        }
        return deleted;
      },
    },

    columnProfiles: {
      async listBySource(projectId, sourceId) {
        await Promise.resolve();
        const columns = profiles.get(`${projectId}/${sourceId}`) ?? [];
        return structuredClone(columns).sort((a, b) => a.position - b.position);
      },
      async deleteBySource(projectId, sourceId) {
        await Promise.resolve();
        const key = `${projectId}/${sourceId}`;
        const count = profiles.get(key)?.length ?? 0;
        profiles.delete(key);
        return count;
      },
      async deleteByProject(projectId) {
        await Promise.resolve();
        let deleted = 0;
        for (const [key, columns] of profiles) {
          if (!key.startsWith(`${projectId}/`)) continue;
          deleted += columns.length;
          profiles.delete(key);
        }
        return deleted;
      },
      workerSave({ projectId, sourceId, columns, source }) {
        profiles.set(`${projectId}/${sourceId}`, structuredClone(columns));
        const stored = sources.get(sourceId);
        if (stored) Object.assign(stored, structuredClone(source), { updatedAt: tick() });
      },
    },

    jobs: {
      async create(input) {
        await Promise.resolve();
        const at = tick();
        const job: Job = {
          id: newId(),
          ...structuredClone(input),
          status: 'queued',
          progress: 0,
          message: 'Waiting to start',
          result: null,
          error: null,
          attempts: 0,
          queuedAt: at,
          startedAt: null,
          finishedAt: null,
          heartbeatAt: null,
          createdAt: at,
          updatedAt: at,
        };
        jobs.set(job.id, job);
        return structuredClone(job);
      },
      async findById(id) {
        await Promise.resolve();
        const job = jobs.get(id);
        return job ? structuredClone(job) : null;
      },
      async listByProject(projectId, limit) {
        await Promise.resolve();
        return [...jobs.values()]
          .filter((j) => j.projectId === projectId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, limit)
          .map((j) => structuredClone(j));
      },
      async listActive(projectId, type) {
        await Promise.resolve();
        return [...jobs.values()]
          .filter(
            (j) =>
              j.projectId === projectId &&
              j.type === type &&
              (j.status === 'queued' || j.status === 'running'),
          )
          .map((j) => structuredClone(j));
      },
      async finishIfActive(id, { status, message, error }, at) {
        await Promise.resolve();
        const job = jobs.get(id);
        if (!job || (job.status !== 'queued' && job.status !== 'running')) return null;
        Object.assign(job, { status, message, error, finishedAt: at, updatedAt: tick() });
        return structuredClone(job);
      },
      async failIfStale(id, cutoff, error, at) {
        await Promise.resolve();
        const job = jobs.get(id);
        if (job?.status !== 'running') return null;
        if (job.heartbeatAt && job.heartbeatAt >= cutoff) return null;
        Object.assign(job, {
          status: 'failed',
          message: error.message,
          error,
          finishedAt: at,
          updatedAt: tick(),
        });
        return structuredClone(job);
      },
      async deleteByProject(projectId) {
        await Promise.resolve();
        let deleted = 0;
        for (const [id, job] of jobs) {
          if (job.projectId !== projectId) continue;
          jobs.delete(id);
          deleted += 1;
        }
        return deleted;
      },
      workerUpdate(id, patch) {
        const job = jobs.get(id);
        if (!job) throw new Error(`no job ${id}`);
        Object.assign(job, structuredClone(patch), { updatedAt: tick() });
      },
    },

    targetSchemas: {
      async findByProject(projectId) {
        await Promise.resolve();
        const schema = schemas.get(projectId);
        return schema ? structuredClone(schema) : null;
      },
      async createIfMissing(projectId, input) {
        await Promise.resolve();
        const existing = schemas.get(projectId);
        if (existing) return structuredClone(existing);
        const at = tick();
        const schema: TargetSchema = {
          projectId,
          ...structuredClone(input),
          version: 1,
          updatedBy: null,
          createdAt: at,
          updatedAt: at,
        };
        schemas.set(projectId, schema);
        return structuredClone(schema);
      },
      async replace(projectId, expectedVersion, input, updatedBy) {
        await Promise.resolve();
        const schema = schemas.get(projectId);
        if (schema?.version !== expectedVersion) return null;
        Object.assign(schema, structuredClone(input), {
          version: expectedVersion + 1,
          updatedBy,
          updatedAt: tick(),
        });
        return structuredClone(schema);
      },
      async deleteByProject(projectId) {
        await Promise.resolve();
        return schemas.delete(projectId) ? 1 : 0;
      },
    },

    mappings: {
      async listSuggestions(projectId, sourceId) {
        await Promise.resolve();
        const stored = suggestions.get(`${projectId}/${sourceId}`) ?? [];
        return structuredClone(stored).sort((a, b) => a.position - b.position);
      },
      async listDecisions(projectId, sourceId) {
        await Promise.resolve();
        return structuredClone([...(decisions.get(`${projectId}/${sourceId}`)?.values() ?? [])]);
      },
      async saveDecision(projectId, sourceId, decision) {
        await Promise.resolve();
        const key = `${projectId}/${sourceId}`;
        const byColumn = decisions.get(key) ?? new Map<string, MappingDecision>();
        byColumn.set(decision.column, structuredClone(decision));
        decisions.set(key, byColumn);
      },
      async deleteBySource(projectId, sourceId) {
        await Promise.resolve();
        suggestions.delete(`${projectId}/${sourceId}`);
        decisions.delete(`${projectId}/${sourceId}`);
      },
      async deleteByProject(projectId) {
        await Promise.resolve();
        dropPrefix(suggestions, projectId);
        dropPrefix(decisions, projectId);
      },
      workerSave({ projectId, sourceId, suggestions: stored }) {
        suggestions.set(`${projectId}/${sourceId}`, structuredClone(stored));
      },
    },

    stagedRecords: {
      async list(projectId, sourceId, { runId, afterRow, limit, issuesOnly }) {
        await Promise.resolve();
        const run = staged.get(`${projectId}/${sourceId}`);
        if (run?.runId !== runId) return [];
        return structuredClone(
          run.rows
            .filter((r) => r.rowNumber > afterRow && (!issuesOnly || r.issues.length > 0))
            .sort((a, b) => a.rowNumber - b.rowNumber)
            .slice(0, limit)
            .map(({ id: _id, sourceId: _source, ...row }): StagedRecord => row),
        );
      },
      async findByIds(projectId, ids) {
        await Promise.resolve();
        const wanted = new Set(ids);
        const found = [...staged.entries()]
          .filter(([key]) => key.startsWith(`${projectId}/`))
          .flatMap(([, run]) => run.rows.filter((r) => wanted.has(r.id)));
        return structuredClone(found);
      },
      async deleteBySource(projectId, sourceId) {
        await Promise.resolve();
        staged.delete(`${projectId}/${sourceId}`);
      },
      async deleteByProject(projectId) {
        await Promise.resolve();
        dropPrefix(staged, projectId);
      },
      workerSave({ projectId, sourceId, runId, rows, source }) {
        staged.set(`${projectId}/${sourceId}`, {
          runId,
          rows: rows.map(({ id, ...row }) => ({
            ...structuredClone(row),
            id: id ?? newId(),
            sourceId,
          })),
        });
        const stored = sources.get(sourceId);
        if (stored) Object.assign(stored, structuredClone(source), { updatedAt: tick() });
      },
    },

    candidates: {
      async findSummary(projectId) {
        await Promise.resolve();
        const run = candidates.get(projectId);
        return run ? structuredClone(run.summary) : null;
      },
      async listPairs(projectId, { runId, afterPosition, limit }) {
        await Promise.resolve();
        const run = candidates.get(projectId);
        if (run?.summary.runId !== runId) return [];
        return structuredClone(
          run.pairs
            .filter((p) => p.position > afterPosition)
            .sort((a, b) => a.position - b.position)
            .slice(0, limit),
        );
      },
      async deleteByProject(projectId) {
        await Promise.resolve();
        candidates.delete(projectId);
      },
      workerSave({ projectId, pairs, summary }) {
        candidates.set(projectId, structuredClone({ summary, pairs }));
      },
    },

    scores: {
      async findSummary(projectId) {
        await Promise.resolve();
        const run = scores.get(projectId);
        return run ? structuredClone(run.summary) : null;
      },
      async listScores(projectId, { runId, band, afterPosition, limit }) {
        await Promise.resolve();
        const run = scores.get(projectId);
        if (run?.summary.runId !== runId) return [];
        return structuredClone(
          run.scores
            .filter((s) => s.position > afterPosition && (!band || s.band === band))
            .sort((a, b) => a.position - b.position)
            .slice(0, limit),
        );
      },
      async deleteByProject(projectId) {
        await Promise.resolve();
        scores.delete(projectId);
      },
      workerSave({ projectId, scores: written, summary }) {
        scores.set(projectId, structuredClone({ summary, scores: written }));
      },
    },

    audit: {
      async append(entry) {
        await Promise.resolve();
        const stored: AuditEntry = { id: newId(), ...structuredClone(entry), createdAt: tick() };
        audit.push(stored);
        return structuredClone(stored);
      },
      async listByProject(projectId, { skip, limit }) {
        await Promise.resolve();
        const entries = audit
          .filter((e) => e.projectId === projectId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return {
          items: entries.slice(skip, skip + limit).map((e) => structuredClone(e)),
          limit,
          total: entries.length,
        };
      },
    },
  };
}
