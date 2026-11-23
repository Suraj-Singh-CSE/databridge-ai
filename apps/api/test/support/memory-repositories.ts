import { randomBytes } from 'node:crypto';

import { DuplicateKeyError } from '../../src/errors.js';
import type { AuditEntry } from '../../src/modules/audit/audit.types.js';
import type {
  CandidatePair,
  CandidateRepository,
  CandidateSummary,
} from '../../src/modules/candidates/candidate.types.js';
import type {
  AuditCount,
  DashboardRepository,
  JobCount,
  LlmCall,
  LlmDay,
  LlmErrorCount,
  LlmTaskTotals,
} from '../../src/modules/dashboard/dashboard.types.js';
import type { Job, JobRepository, JobType } from '../../src/modules/jobs/job.types.js';
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
  Cluster,
  ClusterRepository,
  ClusterSummary,
  GoldenRecord,
  ClusterApproval,
  PairDecision,
} from '../../src/modules/clusters/cluster.types.js';
import type { ExportRecord, ExportRepository } from '../../src/modules/exports/export.types.js';
import type { SqlVersion, SqlVersionRepository } from '../../src/modules/sql/sql.types.js';
import type {
  ColumnProfile,
  ColumnProfileRepository,
} from '../../src/modules/sources/column-profile.types.js';
import type {
  QualityRepository,
  QualityRules,
  QualityRun,
} from '../../src/modules/quality/quality.types.js';
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

/** What the Python clustering worker writes: one run's clusters, golden records and summary. */
export interface ClusterWrite {
  projectId: string;
  clusters: Cluster[];
  golden: GoldenRecord[];
  summary: ClusterSummary;
}

export interface MemoryRepositories extends Repositories {
  jobs: JobRepository & { workerUpdate(id: string, patch: WorkerPatch): void };
  columnProfiles: ColumnProfileRepository & { workerSave(write: ProfileWrite): void };
  mappings: MappingRepository & { workerSave(write: SuggestionWrite): void };
  stagedRecords: StagedRecordRepository & { workerSave(write: StagedWrite): void };
  candidates: CandidateRepository & { workerSave(write: CandidateWrite): void };
  scores: ScoreRepository & { workerSave(write: ScoreWrite): void };
  clusters: ClusterRepository & { workerSave(write: ClusterWrite): void };
  exports: ExportRepository & { workerSave(record: ExportRecord): void };
  sqlVersions: SqlVersionRepository & { workerSave(version: SqlVersion): void };
  quality: QualityRepository & { workerSave(run: QualityRun): void };
  /** `workerLlmCall`: what the ai-service LLM gateway appends to `llm_calls`. */
  dashboard: DashboardRepository & { workerLlmCall(call: LlmCall): void };
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
  // key: projectId; one run per project (the worker drops older runs).
  const clusters = new Map<string, Omit<ClusterWrite, 'projectId'>>();
  // key: projectId; one decision per (keyA, keyB) and one approval per customer id.
  const pairDecisions = new Map<string, Map<string, PairDecision>>();
  const approvals = new Map<string, Map<string, ClusterApproval>>();
  const approvable = (c: Cluster) =>
    c.size >= 2 && c.label === 'High' && !c.flags.includes('needs_review');
  const inProject = <T>(map: Map<string, Map<string, T>>, projectId: string) => {
    let found = map.get(projectId);
    if (!found) {
      found = new Map();
      map.set(projectId, found);
    }
    return found;
  };
  const dropPrefix = (map: Map<string, unknown>, projectId: string) => {
    for (const key of map.keys()) if (key.startsWith(`${projectId}/`)) map.delete(key);
  };
  // key: export id (= the export job's id).
  const exportRecords = new Map<string, ExportRecord>();
  // key: version id (= the sql_draft job's id).
  const sqlVersions = new Map<string, SqlVersion>();
  const versionIn = (projectId: string, versionId: string) => {
    const found = sqlVersions.get(versionId.toLowerCase());
    return found?.projectId === projectId ? found : undefined;
  };
  // key: quality run id (= the quality job's id); rules: one document per project.
  const qualityRuns = new Map<string, QualityRun>();
  const qualityRules = new Map<string, QualityRules>();
  const runsOf = (projectId: string) =>
    [...qualityRuns.values()]
      .filter((r) => r.projectId === projectId)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime() || (a.id < b.id ? 1 : -1));
  const audit: AuditEntry[] = [];
  const llmCalls: LlmCall[] = [];
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
      async listScores(projectId, { runId, band, suggestedBand, afterPosition, limit }) {
        await Promise.resolve();
        const run = scores.get(projectId);
        if (run?.summary.runId !== runId) return [];
        return structuredClone(
          run.scores
            .filter(
              (s) =>
                s.position > afterPosition &&
                (!band || s.band === band) &&
                (!suggestedBand || s.suggestedBand === suggestedBand),
            )
            .sort((a, b) => a.position - b.position)
            .slice(0, limit),
        );
      },
      async findAmong(projectId, runId, recordIds) {
        await Promise.resolve();
        const run = scores.get(projectId);
        if (run?.summary.runId !== runId) return [];
        return structuredClone(
          run.scores
            .filter((s) => recordIds.includes(s.recordA) && recordIds.includes(s.recordB))
            .sort((a, b) => a.position - b.position),
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

    clusters: {
      async findSummary(projectId) {
        await Promise.resolve();
        const run = clusters.get(projectId);
        return run ? structuredClone(run.summary) : null;
      },
      async listClusters(
        projectId,
        { runId, flag, minSize, aiSuggested, customerIds, afterPosition, limit },
      ) {
        await Promise.resolve();
        const run = clusters.get(projectId);
        if (run?.summary.runId !== runId) return [];
        const idMatches = (id: string) =>
          !customerIds ||
          ('in' in customerIds ? customerIds.in.includes(id) : !customerIds.notIn.includes(id));
        return structuredClone(
          run.clusters
            .filter(
              (c) =>
                c.position > afterPosition &&
                (!flag || c.flags.includes(flag)) &&
                (!minSize || c.size >= minSize) &&
                (aiSuggested === undefined || c.aiSuggested === aiSuggested) &&
                idMatches(c.customerId),
            )
            .sort((a, b) => a.position - b.position)
            .slice(0, limit),
        );
      },
      async findCluster(projectId, runId, customerId) {
        await Promise.resolve();
        const run = clusters.get(projectId);
        if (run?.summary.runId !== runId) return null;
        const found = run.clusters.find((c) => c.customerId === customerId);
        return found ? structuredClone(found) : null;
      },
      async findGolden(projectId, runId, customerIds) {
        await Promise.resolve();
        const run = clusters.get(projectId);
        if (run?.summary.runId !== runId) return [];
        return structuredClone(run.golden.filter((g) => customerIds.includes(g.customerId)));
      },
      async countWithIds(projectId, runId, customerIds) {
        await Promise.resolve();
        const run = clusters.get(projectId);
        if (run?.summary.runId !== runId) return 0;
        return run.clusters.filter((c) => customerIds.includes(c.customerId)).length;
      },
      async listApprovable(projectId, runId) {
        await Promise.resolve();
        const run = clusters.get(projectId);
        if (run?.summary.runId !== runId) return [];
        return structuredClone(
          run.clusters.filter(approvable).sort((a, b) => a.position - b.position),
        );
      },
      async countApprovable(projectId, runId, exceptIds) {
        await Promise.resolve();
        const run = clusters.get(projectId);
        if (run?.summary.runId !== runId) return 0;
        return run.clusters.filter((c) => approvable(c) && !exceptIds.includes(c.customerId))
          .length;
      },
      async deleteByProject(projectId) {
        await Promise.resolve();
        clusters.delete(projectId);
      },
      workerSave({ projectId, ...run }) {
        clusters.set(projectId, structuredClone(run));
      },
    },

    review: {
      async savePairDecisions(projectId, decisions) {
        await Promise.resolve();
        const stored = inProject(pairDecisions, projectId);
        for (const d of decisions) stored.set(`${d.keyA}/${d.keyB}`, structuredClone(d));
      },
      async countPairDecisions(projectId) {
        await Promise.resolve();
        const counts = { same: 0, different: 0 };
        for (const d of inProject(pairDecisions, projectId).values()) counts[d.decision] += 1;
        return counts;
      },
      async deleteApprovalDecisions(projectId, customerId) {
        await Promise.resolve();
        const stored = inProject(pairDecisions, projectId);
        for (const [key, d] of stored) {
          if (d.action === 'approve' && d.customerId === customerId) stored.delete(key);
        }
      },
      async saveApprovals(projectId, written) {
        await Promise.resolve();
        const stored = inProject(approvals, projectId);
        const keys = new Set(written.flatMap((a) => a.memberKeys));
        for (const [id, a] of stored) {
          if (a.memberKeys.some((k) => keys.has(k))) stored.delete(id);
        }
        for (const a of written) stored.set(a.customerId, structuredClone(a));
      },
      async listApprovals(projectId) {
        await Promise.resolve();
        return structuredClone([...inProject(approvals, projectId).values()]);
      },
      async findApprovalsByKeys(projectId, keys) {
        await Promise.resolve();
        return structuredClone(
          [...inProject(approvals, projectId).values()].filter((a) =>
            a.memberKeys.some((k) => keys.includes(k)),
          ),
        );
      },
      async deleteApproval(projectId, customerId) {
        await Promise.resolve();
        const stored = inProject(approvals, projectId);
        const found = stored.get(customerId);
        stored.delete(customerId);
        return found ? structuredClone(found) : null;
      },
      async deleteByProject(projectId) {
        await Promise.resolve();
        pairDecisions.delete(projectId);
        approvals.delete(projectId);
      },
    },

    exports: {
      async listByProject(projectId, limit) {
        await Promise.resolve();
        return structuredClone(
          [...exportRecords.values()]
            .filter((e) => e.projectId === projectId)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(0, limit),
        );
      },
      async findById(projectId, exportId) {
        await Promise.resolve();
        const found = exportRecords.get(exportId.toLowerCase());
        return found?.projectId === projectId ? structuredClone(found) : null;
      },
      async delete(projectId, exportId) {
        await Promise.resolve();
        const found = exportRecords.get(exportId.toLowerCase());
        if (found?.projectId !== projectId) return false;
        return exportRecords.delete(found.id);
      },
      async deleteByProject(projectId) {
        await Promise.resolve();
        for (const [id, e] of exportRecords)
          if (e.projectId === projectId) exportRecords.delete(id);
      },
      workerSave(record) {
        exportRecords.set(record.id, structuredClone(record));
      },
    },

    sqlVersions: {
      async listByProject(projectId, limit) {
        await Promise.resolve();
        return structuredClone(
          [...sqlVersions.values()]
            .filter((v) => v.projectId === projectId)
            .sort((a, b) => b.version - a.version)
            .slice(0, limit),
        );
      },
      async findById(projectId, versionId) {
        await Promise.resolve();
        const found = versionIn(projectId, versionId);
        return found ? structuredClone(found) : null;
      },
      async findApproved(projectId) {
        await Promise.resolve();
        const approved = [...sqlVersions.values()]
          .filter((v) => v.projectId === projectId && v.status === 'approved')
          .sort((a, b) => b.version - a.version);
        return approved[0] ? structuredClone(approved[0]) : null;
      },
      async approve(projectId, versionId, by, at) {
        await Promise.resolve();
        const found = versionIn(projectId, versionId);
        if (found?.status !== 'draft' || !found.testsPassed) return null;
        Object.assign(found, { status: 'approved', approvedBy: by, approvedAt: at });
        const superseded: number[] = [];
        for (const other of sqlVersions.values()) {
          if (other.projectId === projectId && other.status === 'approved' && other !== found) {
            Object.assign(other, { status: 'superseded', supersededAt: at });
            superseded.push(other.version);
          }
        }
        return { version: structuredClone(found), superseded };
      },
      async reject(projectId, versionId, by, at, reason) {
        await Promise.resolve();
        const found = versionIn(projectId, versionId);
        if (!found || (found.status !== 'draft' && found.status !== 'approved')) return null;
        Object.assign(found, {
          status: 'rejected',
          rejectedBy: by,
          rejectedAt: at,
          rejectReason: reason,
        });
        return structuredClone(found);
      },
      async deleteByProject(projectId) {
        await Promise.resolve();
        for (const [id, v] of sqlVersions) if (v.projectId === projectId) sqlVersions.delete(id);
      },
      workerSave(version) {
        sqlVersions.set(version.id, structuredClone(version));
      },
    },

    quality: {
      async listRuns(projectId, { skip, limit }) {
        await Promise.resolve();
        const all = runsOf(projectId);
        const items = all
          .slice(skip, skip + limit)
          .map(({ results: _results, config: _config, ...summary }) => summary);
        return { items: structuredClone(items), total: all.length };
      },
      async findRun(projectId, runId) {
        await Promise.resolve();
        const found = qualityRuns.get(runId.toLowerCase());
        return found?.projectId === projectId ? structuredClone(found) : null;
      },
      async latestRun(projectId) {
        await Promise.resolve();
        const [newest] = runsOf(projectId);
        return newest ? structuredClone(newest) : null;
      },
      async findRules(projectId) {
        await Promise.resolve();
        const found = qualityRules.get(projectId);
        return found ? structuredClone(found) : null;
      },
      async saveRules(projectId, overrides, by, at) {
        await Promise.resolve();
        const saved: QualityRules = { ...structuredClone(overrides), updatedBy: by, updatedAt: at };
        qualityRules.set(projectId, saved);
        return structuredClone(saved);
      },
      async deleteByProject(projectId) {
        await Promise.resolve();
        for (const [id, r] of qualityRuns) if (r.projectId === projectId) qualityRuns.delete(id);
        qualityRules.delete(projectId);
      },
      workerSave(run) {
        qualityRuns.set(run.id, structuredClone(run));
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
    dashboard: {
      async mappingBySource(projectId) {
        await Promise.resolve();
        return [...suggestions.entries()]
          .filter(([key, stored]) => key.startsWith(`${projectId}/`) && stored.length > 0)
          .map(([key, stored]) => {
            const sourceId = key.slice(projectId.length + 1);
            return {
              sourceId,
              columns: stored.length,
              decisions: decisions.get(key)?.size ?? 0,
              schemaVersion: Math.max(...stored.map((s) => s.run.schemaVersion)),
              rulesOnly: stored.some((s) => s.run.method === 'rules'),
            };
          });
      },
      async mappingDecisionLagsMs(projectId, since) {
        await Promise.resolve();
        const lags: number[] = [];
        for (const [key, byColumn] of decisions) {
          if (!key.startsWith(`${projectId}/`)) continue;
          const stored = suggestions.get(key) ?? [];
          for (const d of byColumn.values()) {
            const made = stored.find((s) => s.column === d.column)?.run.createdAt;
            const ms = made ? d.decidedAt.getTime() - made.getTime() : -1;
            if (d.decidedAt >= since && ms >= 0) lags.push(ms);
          }
        }
        return lags.sort((a, b) => a - b);
      },
      async countExports(projectId) {
        await Promise.resolve();
        return [...exportRecords.values()].filter((e) => e.projectId === projectId).length;
      },
      async auditCounts(projectId, since, actions) {
        await Promise.resolve();
        const counts = new Map<string, AuditCount>();
        for (const e of audit) {
          if (e.projectId !== projectId || e.createdAt < since || !actions.includes(e.action)) {
            continue;
          }
          const raw = e.action === 'mapping.decide' ? e.after?.decision : null;
          const decision = typeof raw === 'string' ? raw : null;
          const key = `${e.action}|${decision ?? ''}|${e.actorId}`;
          const found = counts.get(key);
          if (found) found.count += 1;
          else counts.set(key, { action: e.action, decision, actorId: e.actorId, count: 1 });
        }
        return [...counts.values()];
      },
      async jobStats(projectId, since) {
        await Promise.resolve();
        const inRange = [...jobs.values()].filter(
          (j) => j.projectId === projectId && j.createdAt >= since,
        );
        const counts = new Map<string, JobCount>();
        const durations = new Map<JobType, number[]>();
        for (const j of inRange) {
          const errorCode = j.error?.code ?? null;
          const key = `${j.type}|${j.status}|${errorCode ?? ''}`;
          const found = counts.get(key);
          if (found) found.count += 1;
          else counts.set(key, { type: j.type, status: j.status, errorCode, count: 1 });
          if (j.status === 'succeeded' && j.startedAt && j.finishedAt) {
            const list = durations.get(j.type) ?? [];
            list.push(j.finishedAt.getTime() - j.startedAt.getTime());
            durations.set(j.type, list);
          }
        }
        const failures = inRange
          .filter((j) => j.status === 'failed')
          .map((j) => ({
            type: j.type,
            code: j.error?.code ?? null,
            at: j.finishedAt ?? j.updatedAt,
          }))
          .sort((a, b) => b.at.getTime() - a.at.getTime())
          .slice(0, 5);
        return {
          counts: [...counts.values()],
          durations: [...durations].map(([type, ms]) => ({
            type,
            durationsMs: ms.sort((a, b) => a - b),
          })),
          failures,
        };
      },
      async llmStats(projectId, since) {
        await Promise.resolve();
        const calls = llmCalls.filter((c) => c.projectId === projectId && c.createdAt >= since);
        const tasks = new Map<string, LlmTaskTotals>();
        const errors = new Map<string, LlmErrorCount>();
        const days = new Map<string, LlmDay>();
        for (const c of calls) {
          const t = tasks.get(c.task) ?? {
            task: c.task,
            calls: 0,
            ok: 0,
            cacheHits: 0,
            schemaFallbacks: 0,
            inputTokens: 0,
            outputTokens: 0,
            costInr: 0,
            models: [],
            latenciesMs: [],
          };
          t.calls += 1;
          t.ok += c.outcome === 'ok' ? 1 : 0;
          t.cacheHits += c.cacheHit ? 1 : 0;
          t.schemaFallbacks += c.schemaFallback ? 1 : 0;
          t.inputTokens += c.inputTokens;
          t.outputTokens += c.outputTokens;
          t.costInr += c.costInr;
          if (!t.models.includes(c.model)) t.models.push(c.model);
          if (c.outcome === 'ok' && !c.cacheHit) t.latenciesMs.push(c.latencyMs);
          tasks.set(c.task, t);
          if (c.outcome === 'error') {
            const key = `${c.task}|${c.errorStatus ?? ''}|${c.errorCode ?? ''}|${c.errorType ?? ''}`;
            const e = errors.get(key) ?? {
              task: c.task,
              status: c.errorStatus,
              httpCode: c.errorCode,
              errorType: c.errorType,
              count: 0,
            };
            e.count += 1;
            errors.set(key, e);
          }
          const date = c.createdAt.toISOString().slice(0, 10);
          const d = days.get(date) ?? { date, calls: 0, tokens: 0, costInr: 0 };
          d.calls += 1;
          d.tokens += c.inputTokens + c.outputTokens;
          d.costInr += c.costInr;
          days.set(date, d);
        }
        return {
          tasks: [...tasks.values()].map((t) => ({
            ...t,
            models: t.models.sort(),
            latenciesMs: t.latenciesMs.sort((a, b) => a - b),
          })),
          errors: [...errors.values()],
          days: [...days.values()],
        };
      },
      async qualitySeries(projectId, since, limit) {
        await Promise.resolve();
        return runsOf(projectId)
          .filter((r) => r.startedAt >= since)
          .slice(0, limit)
          .reverse()
          .map((r) => ({
            at: r.startedAt,
            status: r.status,
            pass: r.statusCounts.pass,
            warn: r.statusCounts.warn,
            fail: r.statusCounts.fail,
          }));
      },
      workerLlmCall(call) {
        llmCalls.push(structuredClone(call));
      },
    },
  };
}
