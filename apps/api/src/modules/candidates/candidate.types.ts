/**
 * Candidate pairs: pairs of staged records that share at least one blocking key, written by the
 * `candidates` job (apps/ai-service/app/matching). See ADR 0015. Counts and key types only;
 * the records' values stay in `staged_records`.
 */

/** The blocking passes, in the order the worker reports them. */
export const CANDIDATE_KEY_TYPES = [
  'phone',
  'email',
  'email_local',
  'dob_name',
  'name_location',
  'name_tokens',
] as const;

export interface KeyCount {
  key: string;
  count: number;
}

/** Which run of a source the pairs were built from. */
export interface CandidateSourceRun {
  sourceId: string;
  runId: string;
  rowCount: number;
}

/** One per project: the last successful run. */
export interface CandidateSummary {
  jobId: string;
  /** `<jobId>:<attempt>` whose pairs are in candidate_pairs. */
  runId: string;
  sources: CandidateSourceRun[];
  recordCount: number;
  possiblePairs: number;
  pairCount: number;
  /** 1 - pairCount / possiblePairs. */
  reductionRatio: number;
  /** Pairs each key type found (a pair found by two keys counts for both). */
  pairsByKey: KeyCount[];
  /** Pairs only this key type found. */
  pairsOnlyByKey: KeyCount[];
  oversizeBlocksSkipped: number;
  oversizeBlocksByKey: KeyCount[];
  maxBlockSize: number;
  finishedAt: Date;
}

export interface CandidatePair {
  /** 1-based; strongest evidence (most key types) first. */
  position: number;
  /** Staged record ids, recordA < recordB. */
  recordA: string;
  recordB: string;
  keys: string[];
}

export interface CandidatePageQuery {
  runId: string;
  afterPosition: number;
  limit: number;
}

export interface CandidateRepository {
  findSummary(projectId: string): Promise<CandidateSummary | null>;
  /** One run's pairs in position order. */
  listPairs(projectId: string, query: CandidatePageQuery): Promise<CandidatePair[]>;
  /** Pairs and summary: on project deletion, and when a source is deleted. */
  deleteByProject(projectId: string): Promise<void>;
}
