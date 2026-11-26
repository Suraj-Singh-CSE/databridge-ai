/**
 * Clusters and golden records: which staged records are one customer, and the one record built
 * for them, written by the `clustering` job (apps/ai-service/app/matching/clustering.py and
 * survivorship.py, ADR 0018). Both are proposals (`status: proposed`) for a person to approve.
 */

export const CLUSTER_STATUSES = ['proposed', 'approved', 'rejected'] as const;
export type ClusterStatus = (typeof CLUSTER_STATUSES)[number];

export const CLUSTER_FLAGS = [
  'needs_review',
  'different_people',
  'conflicting_evidence',
  'too_large',
] as const;
export type ClusterFlag = (typeof CLUSTER_FLAGS)[number];

export const CONFIDENCE_LABELS = ['High', 'Medium', 'Low'] as const;
export type ConfidenceLabel = (typeof CONFIDENCE_LABELS)[number];

export const LINK_KINDS = ['match', 'ai_suggested', 'human'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export const SURVIVORSHIP_RULES = [
  'only_value',
  'most_frequent',
  'most_complete',
  'most_typical',
  'source_trust',
  'most_recent',
  'row_order',
] as const;
export type SurvivorshipRule = (typeof SURVIVORSHIP_RULES)[number];

/** A scored pair (or a person's decision) that holds two members together. */
export interface ClusterLink {
  recordA: string;
  recordB: string;
  score: number;
  kind: LinkKind;
  /** On the cluster's maximum spanning tree: the links it cannot do without. */
  tree: boolean;
}

export interface Cluster {
  /** 1-based, largest cluster first. */
  position: number;
  /** `C` + 12 hex characters, stable while the members stay the same. */
  customerId: string;
  /** Staged record ids, first uploaded source and row first. */
  memberRecordIds: string[];
  size: number;
  /** Weakest score on the spanning tree; null for a single record. */
  confidence: number | null;
  label: ConfidenceLabel | null;
  status: ClusterStatus;
  flags: ClusterFlag[];
  /** Plain-language reasons for the flags; never values. */
  reasons: string[];
  /** Some member joined only through an AI-suggested match. */
  aiSuggested: boolean;
  links: ClusterLink[];
}

export interface FieldAlternative {
  value: string;
  count: number;
  recordIds: string[];
  sources: string[];
}

/** Where one golden value came from. */
export interface FieldProvenance {
  /** null when no member has the field. */
  recordId: string | null;
  source: string | null;
  rule: SurvivorshipRule | null;
  /** Every distinct value among the members, the chosen one first. */
  alternatives: FieldAlternative[];
}

export interface GoldenRecord {
  customerId: string;
  status: ClusterStatus;
  /** Target field -> chosen standardised value (and `customer_id`). */
  fields: Record<string, string | null>;
  provenance: Record<string, FieldProvenance>;
}

/** One per project: the last successful run. */
export interface ClusterSummary {
  jobId: string;
  /** `<jobId>:<attempt>` whose documents are in clusters and golden_records. */
  runId: string;
  /** The scoring run and candidates run that were clustered. */
  scoresRunId: string;
  candidatesRunId: string;
  /** The AI review whose suggestions were seen; null when none had run. */
  aiReviewJobId: string | null;
  recordCount: number;
  clusterCount: number;
  singletonCount: number;
  multiRecordCount: number;
  needsReviewCount: number;
  aiSuggestedCount: number;
  averageSize: number;
  largestCluster: number;
  /** A person's decisions the run applied. */
  decisionCount: number;
  /** Decisions naming a record that no longer exists (its source was deleted or changed). */
  staleDecisionCount: number;
  /** Links cut to keep records marked `different` apart (ADR 0019). */
  cutLinkCount: number;
  /** Of those, links a person had marked `same` (two decisions contradict each other). */
  conflictingDecisionCount: number;
  settings: { includeAiSuggested: boolean; maxClusterSize: number; sourceTrust: string[] };
  finishedAt: Date;
}

export interface ClusterPageQuery {
  runId: string;
  flag?: ClusterFlag | undefined;
  minSize?: number | undefined;
  aiSuggested?: boolean | undefined;
  /** Only these customer ids (`in`) or all but these (`notIn`): the approval filter. */
  customerIds?: { in: string[] } | { notIn: string[] } | undefined;
  afterPosition: number;
  limit: number;
}

export interface ClusterRepository {
  findSummary(projectId: string): Promise<ClusterSummary | null>;
  /** One run's clusters in position order (largest first). */
  listClusters(projectId: string, query: ClusterPageQuery): Promise<Cluster[]>;
  findCluster(projectId: string, runId: string, customerId: string): Promise<Cluster | null>;
  findGolden(projectId: string, runId: string, customerIds: string[]): Promise<GoldenRecord[]>;
  /** How many clusters of the run have one of these customer ids. */
  countWithIds(projectId: string, runId: string, customerIds: string[]): Promise<number>;
  /** Clusters "Approve all High" may approve: 2+ records, label High, no `needs_review`. */
  listApprovable(projectId: string, runId: string): Promise<Cluster[]>;
  /** How many of those are not among these (already approved) customer ids. */
  countApprovable(projectId: string, runId: string, exceptIds: string[]): Promise<number>;
  /** Clusters, golden records and summary: on project deletion, and when a source is deleted. */
  deleteByProject(projectId: string): Promise<void>;
}

/* ---------- Review decisions (M4.6b, ADR 0019) ---------- */

export const PAIR_DECISIONS = ['same', 'different'] as const;
export type PairDecisionValue = (typeof PAIR_DECISIONS)[number];
export const DECISION_ACTIONS = ['approve', 'split', 'merge'] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];

/**
 * A person's decision on two staged records (`match_decisions`), the source of truth the
 * clustering job applies. Keys are `<sourceId>:<sourceRecordId>` (or `#<row>`), the same keys
 * as customer ids, so a decision survives re-standardisation; one decision per key pair.
 */
export interface PairDecision {
  recordA: string;
  recordB: string;
  keyA: string;
  keyB: string;
  decision: PairDecisionValue;
  /** Which review action wrote it, and on which customer id. */
  action: DecisionAction;
  customerId: string;
  reason: string | null;
  decidedBy: string;
  decidedAt: Date;
  /** The clustering run the reviewer was looking at. */
  runId: string;
}

/** An approved cluster (`cluster_approvals`), keyed by its membership (= its customer id). */
export interface ClusterApproval {
  customerId: string;
  memberKeys: string[];
  approvedBy: string;
  approvedAt: Date;
  runId: string;
}

export interface ReviewRepository {
  /** Upserts by (keyA, keyB): a later decision on the same two records replaces the earlier. */
  savePairDecisions(projectId: string, decisions: PairDecision[]): Promise<void>;
  countPairDecisions(projectId: string): Promise<Record<PairDecisionValue, number>>;
  /** Removes the `same` decisions an approval of this customer id wrote. */
  deleteApprovalDecisions(projectId: string, customerId: string): Promise<void>;
  /**
   * Saves approvals, one upsert per customer id (safe when two reviewers approve at once);
   * approvals of other customers sharing a member with a new one are removed (superseded).
   */
  saveApprovals(projectId: string, approvals: ClusterApproval[]): Promise<void>;
  /** Removes these customers' approvals made on clustering run `runId` (a refused write). */
  deleteApprovalsOfRun(projectId: string, customerIds: string[], runId: string): Promise<void>;
  /** Every approval of the project (stale ones too: they explain "membership changed"). */
  listApprovals(projectId: string): Promise<ClusterApproval[]>;
  /** Approvals holding any of these member keys. */
  findApprovalsByKeys(projectId: string, keys: string[]): Promise<ClusterApproval[]>;
  deleteApproval(projectId: string, customerId: string): Promise<ClusterApproval | null>;
  /** On project deletion only: decisions outlive a deleted source (they are counted stale). */
  deleteByProject(projectId: string): Promise<void>;
}
