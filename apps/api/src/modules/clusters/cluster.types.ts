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
  decisionCount: number;
  settings: { includeAiSuggested: boolean; maxClusterSize: number; sourceTrust: string[] };
  finishedAt: Date;
}

export interface ClusterPageQuery {
  runId: string;
  status?: ClusterStatus | undefined;
  flag?: ClusterFlag | undefined;
  minSize?: number | undefined;
  afterPosition: number;
  limit: number;
}

export interface ClusterRepository {
  findSummary(projectId: string): Promise<ClusterSummary | null>;
  /** One run's clusters in position order (largest first). */
  listClusters(projectId: string, query: ClusterPageQuery): Promise<Cluster[]>;
  findCluster(projectId: string, runId: string, customerId: string): Promise<Cluster | null>;
  findGolden(projectId: string, runId: string, customerIds: string[]): Promise<GoldenRecord[]>;
  /** Clusters, golden records and summary: on project deletion, and when a source is deleted. */
  deleteByProject(projectId: string): Promise<void>;
}
