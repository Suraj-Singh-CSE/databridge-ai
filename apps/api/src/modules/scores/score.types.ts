/**
 * Pair scores: how likely each candidate pair is one person, written by the `scoring` job
 * (apps/ai-service/app/matching/scoring.py). See ADR 0016. Levels, weights and plain-language
 * reasons only; the records' values stay in `staged_records`.
 */

export const SCORE_BANDS = ['match', 'maybe', 'non_match'] as const;
export type ScoreBand = (typeof SCORE_BANDS)[number];

/** One field's contribution: weight in bits (log2 m/u), positive for a match. */
export interface ScoreReason {
  field: string;
  level: string;
  weight: number;
  text: string;
}

export const AI_DECISIONS = ['same', 'different', 'unsure'] as const;
export type AiDecision = (typeof AI_DECISIONS)[number];
/** `reviewed`: the AI answered; `unavailable`: it was asked but gave no usable answer. */
export const AI_STATUSES = ['reviewed', 'unavailable'] as const;
export type AiStatus = (typeof AI_STATUSES)[number];

/**
 * The AI's suggestion for a `maybe` pair, written by the `pair_review` job
 * (apps/ai-service/app/matching/review.py, ADR 0017). It never changes `band`; a person decides.
 * All null on pairs the AI has not been asked about.
 */
export interface AiSuggestionFields {
  aiStatus: AiStatus | null;
  aiDecision: AiDecision | null;
  /** 0-1. */
  aiConfidence: number | null;
  /** Short plain-language sentence; never contains record values. */
  aiReason: string | null;
  aiModel: string | null;
  aiPromptVersion: string | null;
  reviewedAt: Date | null;
  /** The AI decision when its confidence clears the threshold, else `band` (`maybe`). */
  suggestedBand: ScoreBand;
}

export interface PairScore extends AiSuggestionFields {
  /** 1-based, highest score first. */
  position: number;
  /** Staged record ids, recordA < recordB. */
  recordA: string;
  recordB: string;
  /** Match probability, 0-1. */
  score: number;
  band: ScoreBand;
  /** Prior plus the field weights, in bits. */
  matchWeight: number;
  /** Field -> level (`exact`, `close`, `different`, `missing`, ...). */
  fieldLevels: Record<string, string>;
  reasons: ScoreReason[];
}

export interface ScoreModelLevel {
  level: string;
  m: number;
  u: number;
  weight: number;
}

/** The Fellegi-Sunter model the run used: EM-estimated or the hand-set defaults. */
export interface ScoreModel {
  method: 'em' | 'defaults';
  emIterations: number;
  emConverged: boolean;
  /** Why EM's estimate was not used; null when it was. */
  fallbackReason: string | null;
  matchProportion: number;
  priorWeight: number;
  fields: { field: string; levels: ScoreModelLevel[] }[];
}

export interface BandCount {
  band: ScoreBand;
  count: number;
}

/** Counts of the last `pair_review` run on this scoring run. */
export interface AiReviewSummary {
  jobId: string;
  promptVersion: string;
  /** null when no call answered. */
  model: string | null;
  confidenceThreshold: number;
  pairCount: number;
  reviewed: number;
  same: number;
  different: number;
  unsure: number;
  unavailable: number;
  suggestedMatch: number;
  suggestedNonMatch: number;
  calls: number;
  failedCalls: number;
  finishedAt: Date;
}

/** One per project: the last successful run. */
export interface ScoreSummary {
  jobId: string;
  /** `<jobId>:<attempt>` whose scores are in pair_scores. */
  runId: string;
  /** The candidates run that was scored. */
  candidatesRunId: string;
  pairCount: number;
  bandCounts: BandCount[];
  thresholds: { match: number; maybe: number };
  model: ScoreModel;
  finishedAt: Date;
  /** null until the AI has reviewed this run's maybe pairs. */
  aiReview: AiReviewSummary | null;
}

export interface ScorePageQuery {
  runId: string;
  /** Only this band; every band when absent. */
  band?: ScoreBand | undefined;
  /** Only pairs with this suggested band (`band` when the AI has not moved it). */
  suggestedBand?: ScoreBand | undefined;
  afterPosition: number;
  limit: number;
}

export interface ScoreRepository {
  findSummary(projectId: string): Promise<ScoreSummary | null>;
  /** One run's scores in position order (highest score first). */
  listScores(projectId: string, query: ScorePageQuery): Promise<PairScore[]>;
  /** One run's scored pairs whose two records are both among these ids (a cluster's links). */
  findAmong(projectId: string, runId: string, recordIds: readonly string[]): Promise<PairScore[]>;
  /** Scores and summary: on project deletion, and when a source is deleted. */
  deleteByProject(projectId: string): Promise<void>;
}
