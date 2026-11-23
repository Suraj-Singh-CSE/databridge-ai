# ADR 0024: Knowledge index for the project assistant (retrieval)

- Status: Accepted
- Date: 2026-11-23

## Context

The project assistant (M6.2) will answer questions such as "Why were these two records merged?",
"Why did PIN completeness fail?" or "Who approved the SQL?". The answers are already in what the
pipeline stores: clusters with their links and golden-record provenance, pair scores with
reasons, AI review decisions, mapping suggestions and decisions, quality runs, SQL versions and
the audit log, plus the project's own documentation (README and ADRs). An LLM must not see raw
personal data (contributor rule 6), and the answering step will send retrieved text to a model.
So the retrieval step must find the right passages and must never hold a customer value in the
first place. This ADR covers the retrieval half; answer generation and the public search route
are M6.2b.

## Decision

**Value-free chunks.** `app/knowledge/chunks.py` turns stored facts into short plain-language
passages from fixed templates. The builders' inputs (`CustomerFacts`, `DecisionFacts`, ...) have
no field for a record value: only ids, field and source names, row numbers, rule names, codes,
counts, statuses, confidence labels and reasons in words. Each chunk is
`{id, projectId, kind, title, text, refs, link, updatedAt}`:

| Kind       | One chunk per                                                                          | What it says                                                                                                                                                                                                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `customer` | multi-record cluster of the current run                                                | size, sources, confidence label, flags, approval status, each spanning-tree link with its scoring reasons ("Same phone", "Names very similar (0.94)") and AI review decision/reason, and per golden field the rule and source row that chose it ("full_name from crm_export row 12 by most complete") |
| `decision` | audit entry of a person (mapping, match, SQL, quality rules, export)                   | action, the actor's role now (owner, member role, admin), time, target ids; a free-text reason only when it matches no PII pattern and holds no staged value                                                                                                                                          |
| `mapping`  | source column                                                                          | chosen target or role, confidence, reason, transform hint, decision                                                                                                                                                                                                                                   |
| `quality`  | rule of the latest run, plus one overview per recent run (`KNOWLEDGE_QUALITY_RUNS`, 5) | rule, metric, thresholds, status, counts, message, up to 10 example customer ids                                                                                                                                                                                                                      |
| `sql`      | SQL version                                                                            | status, method, explanation, assumptions, test results (never the SQL text's result rows)                                                                                                                                                                                                             |
| `docs`     | README and ADR section                                                                 | the section, split at headings (levels 1-3) and again at paragraph breaks above 1,500 characters                                                                                                                                                                                                      |

`refs` (`customerId`, `sourceId`, `column`, `ruleId`, `sqlVersionId`, `adr`) allow filtered
search; `link` (`page`, `params`) names the web page that shows the source of the answer.

**Privacy guard** (`app/knowledge/privacy.py`), on every chunk before it is stored or embedded:

1. Staged values: every value of the target schema's `is_pii` fields in the project's staged
   records (without a schema, every field), expanded as the pair review's leak scan does (whole
   value, name words, phone digits, email local part), matched as whole words. A data chunk
   holding one is dropped and counted (`droppedByPrivacyGuard`).
2. Patterns: the gateway's PII masker (email, PAN, phones, card, Aadhaar). A data chunk that
   matches is dropped.

Docs chunks are the product's own text, not built from records, and are never dropped: their
pattern matches and any complete staged value they quote (the ADRs quote the synthetic samples)
are masked in place (`maskedDocs`); single name words are not checked there because they are
ordinary words ("More", "Jai"). Only counts are logged.

**Embeddings through the gateway.** The provider interface gains `embed(texts, kind)`
(`kind`: `document` or `query`); `LLMGateway.embed` masks every text again (defence in depth),
batches (`EMBEDDING_BATCH_SIZE`, 32), paces each request with the shared limiter, retries like
chat calls, and logs one `llm_calls` record per request under task `embedding`
(`prompt_version` `embed-v1-document` / `embed-v1-query`, tokens, latency, cost). Gemini uses the
installed google-genai SDK's `client.aio.models.embed_content(model, contents=[...],
config=EmbedContentConfig(task_type="RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY",
output_dimensionality=EMBEDDING_DIMENSIONS))` with `GEMINI_EMBEDDING_MODEL`
(default `gemini-embedding-001`, priced 0 like the free tier; 768 dimensions by default). The
Gemini API reports no token count for embeddings, so tokens are estimated (4 characters per
token) unless the response carries them. The Mock provider returns deterministic hashed
bag-of-words vectors (words and word pairs, 256 dimensions) so tests and CI never call a model.
Embeddings are not cached in Redis: the index's content hash already avoids re-embedding.

**Hybrid retrieval with a keyword fallback** (`app/knowledge/retrieval.py`). BM25 (k1 1.2, b
0.75; a small implementation, no new dependency) over the title (counted twice), the text and
the refs' values, with stop words removed and light stemming ("approved", "approve" ->
"approv"), plus cosine similarity of the query vector against the chunk vectors. The two
rankings (top 50 each) are fused with reciprocal rank fusion, `sum 1 / (60 + rank)`, which
needs no calibration between BM25 scores and cosines. Filters (`kinds`, `refs`) apply before
ranking. When the query cannot be embedded (embeddings off, no vectors for the current model,
quota or provider error) the search is BM25 only and says `mode: "keyword"`.

**Storage and rebuild.** `knowledge_chunks` holds one document per chunk (`projectId`,
`chunkId` unique) with its text, metadata, `contentHash` (sha256 of kind, title, text, refs and
link), `vector` (float list or null) and `embeddingModel`. The `knowledge_index` job
(project-level, payload `{}`, started by owner, admin or data_engineer; one at a time,
`409 KNOWLEDGE_INDEX_RUNNING`) rebuilds idempotently: it builds every chunk, reuses the stored
vector of each chunk whose hash and embedding model are unchanged, embeds the rest, upserts by
id and deletes the project's other chunks. An embedding failure does not fail the job: chunks
embedded so far keep their vectors, the summary reports `mode: "keyword"` and
`embeddingError`, and the next run embeds the rest. `knowledge_summaries` holds one summary per
project (chunks by kind, dropped, masked docs, mode, embedding model, embedded, reused,
finishedAt), read by `GET /api/v1/projects/:projectId/knowledge/summary` (any member).

**Search endpoint.** `POST /internal/v1/knowledge/search` on the ai-service (service token;
`projectId`, `query` up to 500 characters, `k` 1-20, `filters.kinds`, `filters.refs`) returns
the chunks with their fused score and both ranks, `mode`, `queryMasked` and `chunkCount`. The
query is masked before it is searched or embedded. The search loads the project's chunks and
ranks them in memory: fine for the hundreds to low thousands of chunks of a project here; a
vector database is the follow-up if projects grow well past that. The public, members-only
search route comes with M6.2b.

**Docs in Docker.** The image does not contain the repository, so the ai-service Dockerfile
copies `README.md` and `docs/adr/` to `/app/knowledge-docs` (same layout; `.dockerignore`
re-includes `docs/adr`) and sets `KNOWLEDGE_DOCS_DIR`. Outside Docker the default is the
repository the code runs from. This was chosen over a build-time packaged copy inside
`app/`: one source of truth, nothing to keep in sync.

## Evaluation

`python -m dbeval.evaluate_retrieval` builds the seed 42 samples' project with the pure
pipeline (rules mapping suggestions, clusters and golden records with provenance and pair-score
reasons, the reference SQL version, a quality run of the final table, a hand-written audit trail
with one reason holding a phone number, the README and ADRs), indexes it with the Mock embedder
and searches 23 hand-written questions, each with the chunks that answer it (quality rules,
customers by id, decisions, mapping columns, the SQL version, ADRs 0006, 0015, 0018, 0022):

| Mode    | Recall@1 | Recall@3 | Recall@5 |  MRR |
| ------- | -------: | -------: | -------: | ---: |
| keyword |     0.78 |     0.87 |     0.96 | 0.85 |
| hybrid  |     0.52 |     0.78 |     0.83 | 0.63 |

Measured on 2026-11-23, 406 chunks (customer 67, decision 7, mapping 25, quality 20, sql 1, docs
286). Privacy guard: 0 chunks dropped, 13 docs chunks masked, 0 chunks holding a staged value;
the phone in the audit reason is not shown.

The Mock embedder hashes words: it has no sense of meaning, so fusing it with BM25 adds noise
and hybrid scores below keyword-only here. The mock run checks the pipeline (every chunk
embedded, fusion, fallback), not the value of embeddings. The real comparison is the opt-in
live run, `task=embedding_retrieval` in the live-eval workflow (Gemini embeddings of the same
synthetic index and questions, same metrics plus tokens, latency and a check that no batch
holds a staged value; default budget 20 calls). CI keeps floors a little below the measured
numbers (`eval/tests/test_evaluate_retrieval.py`).

## Consequences

- The assistant can cite where an answer comes from (`link`) and can never retrieve a customer
  value, so what M6.2b sends to a model is safe by construction; the guard is the second line.
- Answers about a specific value ("which customer is Asha Rao?") are impossible by design; the
  assistant works with customer ids and links to the page that shows the record to a member.
- Every rebuild reads the project's collections and staged records (for the guard); cost grows
  with the project, but only changed chunks are embedded, so the model cost stays small.
- Embedding the whole index is about 14 requests for the samples (406 chunks, 32 per request),
  paced by `LLM_MAX_REQUESTS_PER_MINUTE`; the free tier's token limits may still throttle a
  first build, which then finishes keyword-only and catches up on the next run.
- A changed `GEMINI_EMBEDDING_MODEL` or `EMBEDDING_DIMENSIONS` makes stored vectors unusable for
  search (keyword mode) until the index is rebuilt, which then re-embeds every chunk.
