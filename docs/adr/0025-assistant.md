# ADR 0025: Project assistant answers (grounded generation)

- Status: Accepted
- Date: 2026-11-23

## Context

ADR 0024 built a value-free knowledge index per project and a hybrid search over it. The
assistant now has to turn retrieved chunks into a short answer a data steward can trust. Three
risks drive the design: the model inventing facts (ids, counts, reasons) that the project does
not hold; personal data reaching the model or the stored history (contributor rule 6); and
answers that look sure but cannot be traced back to their source.

## Decision

**Grounded only.** Every answer comes from the retrieved chunks and cites them. The service
says the fixed sentence "I don't have enough information in this project to answer that."
instead of answering whenever it cannot ground the answer. The pipeline
(`app/assistant/answer.py`) is:

1. **Question guard** (no retrieval, no model call when it refuses): length cap (500
   characters, both services); the gateway's PII patterns (email, phone, PAN, Aadhaar, card);
   and the project's staged personal values (`PrivacyGuard` of ADR 0024 over the `is_pii`
   fields: whole values, name words, phone digits, email local parts, as whole words; read from
   MongoDB and kept per project for `ASSISTANT_GUARD_CACHE_SECONDS`, 60). A single word that
   the README and ADRs write in lower case is an ordinary word ("more", "review"), not a name,
   even when a customer's surname is "More"; the complete value is still refused. Refusal:
   "Please ask without customer details — use a customer ID instead." (`personal_data`).
   Customer ids, source, column and rule names are not values and pass.
2. **Retrieve** the top `ASSISTANT_TOP_K` (8) chunks with the M6.2a search (hybrid, or keyword
   when embeddings are unavailable).
3. **Weak-retrieval check**: refuse without a model call (`weak_retrieval`) when no retrieved
   chunk holds at least `ASSISTANT_MIN_TERM_OVERLAP` (0.6) of the question's distinct words
   (the BM25 tokenizer: stop words removed, light stemming, refs' values included). A fused
   rank or cosine says nothing absolute about relevance (RRF scores depend only on ranks), but
   word coverage does: on the samples every answerable question reaches 0.67 or more and the
   out-of-scope ones stay at 0.5 or below ("What is the CEO's salary?" 0.33). An empty index is
   `409 KNOWLEDGE_NOT_BUILT`.
4. **Prompt** `prompts/assistant_v1.txt` (`assistant.v1`, versioned like the other prompts):
   rules (answer only from the numbered sources, cite each factual sentence like `[1]`, the
   fixed sentence when not answerable, never invent ids or numbers, never reveal personal
   details, at most four plain sentences), then INPUT JSON with the numbered sources (kind,
   title, text), the last `ASSISTANT_HISTORY_TURNS` (4) turns (questions and answers only,
   citation markers removed: they referred to that turn's sources) and the question.
5. **One gateway call**, task `assistant` (masking, pacing, retries, cache, cost in
   `llm_calls`), structured output `{answer (<= 1,200 chars), citations, confidence
(high/medium/low), answerable}` with the gateway's no-schema fallback and one repair.
6. **Citation validation**: every `[n]` (also `[1, 2]`) must be listed in `citations` and name
   a source; invalid ones are removed from the text and counted (`invalidCitations`). An
   answer the model marked unanswerable becomes the fixed sentence (`not_answerable`); an
   answer left with no valid citation becomes the fixed sentence too (`no_citation`): an
   uncited claim is not shown.
7. **Answer scan**: PII patterns are masked and staged values are replaced by `[hidden]`, except
   words the answer's own sources hold (the sources are value-free, so such a word is ordinary)
   and ordinary docs words. Only a count (`redactions`) is logged.

Citations are returned as `{n, chunkId, kind, title, link}`; `link` (`page`, `params`) is the
chunk's page, so the web app (M6.3b) can open the source. The Mock provider's responder names
the first one or two sources with their citations and refuses without sources, so tests and CI
are deterministic and never call a model.

**Privacy layers**, in order: the index holds no values (ADR 0024); the question guard; the
gateway masks the whole request again; the answer scan; logs carry reason codes and counts only
(never a question or an answer); the eval checks every prompt and answer.

**API** (`apps/api/src/modules/assistant`). `POST /projects/:projectId/assistant/ask` (members;
Zod: question 1-500 characters trimmed, `conversationId` optional and the caller's own) checks a
per-user limit (`ASSISTANT_RATE_LIMIT_MAX`, 20 per `ASSISTANT_RATE_LIMIT_WINDOW_MS`, 60 s; in
memory per api process: a shared Redis limiter is a Gate 3 item), answers `409
KNOWLEDGE_NOT_BUILT` ("Build the project knowledge index first") without a knowledge summary,
sends the conversation's last answerable turns as history and calls the ai-service with
`ASSISTANT_TIMEOUT_MS` (30 s; the job routes keep 5 s). An unreachable or failing ai-service is
`503 AI_SERVICE_UNAVAILABLE` and nothing is stored.

**Conversation storage.** `assistant_conversations` holds `{projectId, userId, title, turns[]}`,
each turn `{question, answer, citations, confidence, answerable, refusalReason, mode, model,
latencyMs, createdAt}`, capped at the newest `ASSISTANT_MAX_TURNS` (50) with `$push $slice`. A
question refused for personal data is never stored: the turn keeps `question: null` and the
reason code, and the title falls back to "Conversation". Members list and read only their own
conversations (anyone else's is 404, like a non-member's project), and delete them; deletes
are audited (`assistant_conversation.delete`, turn count only), questions are not (they are
noise in the audit log and already stored in the conversation). Conversations are deleted with
the project. `GET .../assistant/usage` (owner, admin, data_engineer) returns counts only:
conversations, users, questions, answered, refusals by reason, average latency, and the
`assistant` task's calls, tokens and cost from `llm_calls`.

## Evaluation

`python -m dbeval.evaluate_assistant` builds the seed 42 samples' index (ADR 0024) and asks the
23 retrieval questions (answerable, each with the chunks that answer it), 8 unanswerable ones
(CEO's salary, weather, cricket, a capital, a translation, a stock price, and two naming a person
who is not in the project) and 5 holding a personal value of the samples (an email, a phone, a
full name, a lower-case full name, a PAN), with the Mock provider:

| Mode    | Answer rate | Refusal (unanswerable) | PII refusal | Groundedness | Citation accuracy | Values in prompts / answers |
| ------- | ----------: | ---------------------: | ----------: | -----------: | ----------------: | --------------------------: |
| keyword |        1.00 |                   1.00 |        1.00 |         1.00 |              0.87 |                       0 / 0 |
| hybrid  |        1.00 |                   1.00 |        1.00 |         1.00 |              0.61 |                       0 / 0 |

Groundedness is checked structurally: every answer has at least one valid citation and every
marker names a cited source. Citation accuracy: a cited chunk is one that answers the question;
the Mock cites the first two retrieved chunks, so it follows retrieval (hybrid is lower because
the Mock embedder hashes words, ADR 0024). All 8 unanswerable questions are refused by the
weak-retrieval check, so no model call is spent on them; the 5 personal-value questions are
refused by the guard. Every prompt the provider received and every answer is checked for complete
staged values: 0. CI keeps floors a little below these numbers and requires 100% PII refusal
and no value anywhere (`eval/tests/test_evaluate_assistant.py`).

The model's real behaviour is measured by the opt-in live run, `task=assistant` in the live-eval
workflow (Gemini on the synthetic samples, keyword retrieval, default budget 40 calls; every
prompt is checked before it is sent and one holding a staged value is never sent): the same
metrics plus tokens and latency.

## Consequences

- An answer is either cited or the fixed sentence; a model that answers without citing loses the
  answer rather than showing an unsupported claim (a cost in answer rate, measured live).
- The weak-retrieval check is lexical: a question phrased with words the index does not use may
  be refused although an answer exists, and an off-topic question sharing many words ("How many
  customers live on Mars?") reaches the model, which must then refuse by itself (rule 3).
- Retrieval uses the question alone; a follow-up such as "and why?" retrieves poorly. History
  only helps the model read the question. Query rewriting is a follow-up if this matters.
- The guard reads the project's staged values (cached 60 s per process); very large projects
  make the first question of a minute slower and hold the values in memory meanwhile.
- The rate limit and guard cache are per process until Gate 3 moves them to Redis.
