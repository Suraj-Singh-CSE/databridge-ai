/** The kinds of chunk in a project's knowledge index (ADR 0024). */
export const CHUNK_KINDS = ['customer', 'decision', 'mapping', 'quality', 'sql', 'docs'] as const;
export type ChunkKind = (typeof CHUNK_KINDS)[number];

/**
 * The summary the `knowledge_index` job stores for a project (apps/ai-service
 * app/worker/handlers/knowledge.py). Counts, codes and a model name only: never chunk text.
 */
export interface KnowledgeSummary {
  projectId: string;
  jobId: string;
  chunkCount: number;
  chunksByKind: Record<ChunkKind, number>;
  /** Data chunks the privacy guard refused because they held a personal value. */
  droppedByPrivacyGuard: number;
  /** Docs chunks whose example values were masked. */
  maskedDocs: number;
  /** `hybrid` when every chunk has a vector, else `keyword`. */
  mode: 'hybrid' | 'keyword';
  embeddingModel: string | null;
  /** Chunks embedded by this run, and chunks whose vector was reused (unchanged). */
  embedded: number;
  reused: number;
  /** Why embedding stopped (e.g. `429 RESOURCE_EXHAUSTED`), or null. */
  embeddingError: string | null;
  finishedAt: Date;
}

export interface KnowledgeRepository {
  findSummary(projectId: string): Promise<KnowledgeSummary | null>;
}
