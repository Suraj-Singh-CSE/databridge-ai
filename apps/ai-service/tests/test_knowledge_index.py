"""Chunk builders, privacy guard, hybrid retrieval and incremental embedding (ADR 0024)."""

from collections.abc import Sequence
from dataclasses import replace
from datetime import UTC, datetime

import pytest

from app.knowledge.chunks import (
    MAX_DOC_CHARS,
    Chunk,
    CustomerFacts,
    DecisionFacts,
    DocFile,
    FieldOrigin,
    Link,
    MappingFacts,
    PairLink,
    QualityRunFacts,
    RecordRef,
    RuleFacts,
    SqlCheckFacts,
    SqlVersionFacts,
    customer_chunk,
    decision_chunk,
    doc_chunks,
    mapping_chunk,
    quality_chunks,
    sql_chunk,
)
from app.knowledge.index import (
    Embedded,
    ProjectFacts,
    StoredVector,
    build_chunks,
    counts_by_kind,
    embed_chunks,
)
from app.knowledge.privacy import MASKED_VALUE, PrivacyGuard, reason_allowed
from app.knowledge.retrieval import BM25, Indexed, cosine, search, tokenize
from app.llm.base import EmbeddingKind, EmbeddingResponse
from app.llm.errors import LLMRateLimitError
from app.llm.mock import hashed_vector

P = "p" * 24
AT = datetime(2026, 11, 23, 10, 15, tzinfo=UTC)
RECORDS = [
    {"full_name": "Asha Rao", "phone": "+919820012345", "email": "asha.rao@mail.com"},
    {"full_name": "Asha R", "phone": "9820012345", "city": "Pune"},
]
PII = ("full_name", "phone", "email")


def customer(**changes: object) -> CustomerFacts:
    facts = CustomerFacts(
        customer_id="C00A1",
        size=2,
        confidence=0.98,
        label="High",
        flags=("needs_review",),
        guard_reasons=("Contains records that look like different people (1 pair)",),
        approved=True,
        members=(RecordRef("r1", "crm_export", 12), RecordRef("r2", "billing_export", None)),
        links=(
            PairLink(
                "r1",
                "r2",
                "ai_suggested",
                0.91,
                ("Same phone", "Names very similar (0.94)"),
                ai_decision="same",
                ai_confidence=0.88,
                ai_reason="Same phone and similar names",
            ),
        ),
        origins=(
            FieldOrigin("full_name", "most_complete", "r1"),
            FieldOrigin("phone", "most_frequent", "r2"),
            FieldOrigin("email", None, None),
            FieldOrigin("city", "made_up_rule", "r9"),
        ),
        updated_at=AT,
    )
    return replace(facts, **changes)  # type: ignore[arg-type]


def rule(**changes: object) -> RuleFacts:
    facts = RuleFacts(
        rule="completeness_optional",
        label="Optional field filled in",
        field="pin_code",
        status="fail",
        metric=61.5,
        unit="percent",
        direction="min",
        warn=90.0,
        fail=70.0,
        message="61.5% of customers have a pin_code (1,234 empty).",
        counts={"filled": 80, "empty": 50},
        example_ids=("C1", "C2"),
    )
    return replace(facts, **changes)  # type: ignore[arg-type]


def test_customer_chunk_explains_links_and_field_choices_without_values() -> None:
    chunk = customer_chunk(P, customer())
    assert chunk.id == "customer:C00A1"
    assert chunk.refs == {"customerId": "C00A1"}
    assert chunk.link == Link("matching", {"customerId": "C00A1"})
    text = chunk.text
    assert "2 records (billing_export, crm_export)" in text
    assert "High confidence (0.98)" in text
    assert "approved by a reviewer" in text
    assert "Flags: needs review." in text
    assert "Warning: Contains records that look like different people" in text
    assert "crm_export row 12 and billing_export: Same phone; Names very similar (0.94)" in text
    assert "linked on the AI review's suggestion, match score 0.91" in text
    assert "AI review: same, confidence 0.88: Same phone and similar names." in text
    assert "full_name from crm_export row 12 by most complete." in text
    assert "phone from billing_export by most frequent." in text
    assert "email: empty, no member record had a value." in text
    assert "city from record r9 by made up rule." in text
    for record in RECORDS:
        for value in record.values():
            assert value not in text


def test_customer_chunk_for_a_proposed_cluster_without_links() -> None:
    chunk = customer_chunk(
        P, customer(approved=False, flags=(), guard_reasons=(), links=(), origins=())
    )
    assert "proposed, not yet approved" in chunk.text
    assert "Flags: none." in chunk.text
    assert "Why these records" not in chunk.text
    bare = customer_chunk(P, customer(confidence=None, label=None))
    assert "no confidence (a single record)" in bare.text
    labelled = customer_chunk(P, customer(confidence=None))
    assert "High confidence." in labelled.text
    plain = PairLink("r1", "r2", "match", None)
    assert "no field comparison stored (linked by the match score)" in (
        customer_chunk(P, customer(links=(plain,))).text
    )


def decision(action: str, entity: str = "C00A1", **details: object) -> DecisionFacts:
    reason = details.pop("reason", None)
    return DecisionFacts(
        entry_id="a1",
        action=action,
        actor_role="data_steward",
        at=AT,
        entity_type=action.split(".")[0],
        entity_id=entity,
        details=details,
        reason=reason if isinstance(reason, str) else None,
        source_name=str(details.get("sourceName")) if details.get("sourceName") else None,
    )


@pytest.mark.parametrize(
    ("facts", "expected", "page"),
    [
        (
            decision("mapping.decide", "s1:ph", column="ph", decision="override", target="phone",
                     sourceId="s1", sourceName="crm_export"),
            "column ph of source crm_export was override (target field phone)",
            "mapping",
        ),
        (decision("mapping.decide", "s1:ph"), "column ph of source a source was decided",
         "mapping"),
        (decision("mapping.accept_high", "s1", accepted=4),
         "every high-confidence column of source s1 was accepted (4 columns)", "mapping"),
        (decision("cluster.approve", size=3, label="High"),
         "customer C00A1 was approved (3 records, High confidence)", "matching"),
        (decision("cluster.unapprove"), "the approval of customer C00A1 was undone", "matching"),
        (decision("cluster.approve_high", approved=12),
         "every high-confidence customer was approved (12 customers)", "matching"),
        (decision("cluster.split", recordId="r2"),
         "customer C00A1 was split by hand, record r2 taken out", "matching"),
        (decision("cluster.merge", customerIds=["C1", "C2"]),
         "customers C1 and C2 were merged by hand", "matching"),
        (decision("cluster.other"), "Match decision: other on customer C00A1", "matching"),
        (decision("sql_version.approve", "v1", version=2), "SQL version 2 (v1) was approved",
         "pipeline"),
        (decision("sql_version.reject", "v1"), "SQL version (v1) was rejected", "pipeline"),
        (decision("quality_rules.update", P), "Quality rules (thresholds)", "quality"),
        (decision("export.download", "e1", format="csv"), "the csv export e1 was downloaded",
         "pipeline"),
        (decision("export.delete", "e1"), "the export e1 was deleted", "pipeline"),
        (decision("job.create", "j1", type="export"), "a golden-record export was requested",
         "pipeline"),
        (decision("source.create", "s1"), "source create on source s1", "dashboard"),
    ],
)  # fmt: skip
def test_decision_sentences(facts: DecisionFacts, expected: str, page: str) -> None:
    chunk = decision_chunk(P, facts, reason_allowed)
    assert expected in chunk.text
    assert "by a data steward on 2026-11-23 10:15 UTC." in chunk.text
    assert chunk.link.page == page
    assert chunk.kind == "decision"


def test_decision_reasons_are_kept_only_when_safe() -> None:
    safe = decision_chunk(P, decision("cluster.split", reason="Different people"), reason_allowed)
    assert "Reason given: Different people" in safe.text
    risky = decision_chunk(
        P, decision("cluster.split", reason="call +91 98200 12345"), reason_allowed
    )
    assert "98200" not in risky.text
    assert "is not shown (it may hold personal data)" in risky.text
    unknown = decision_chunk(P, replace(decision("cluster.split"), at=None), reason_allowed)
    assert "an unknown time" in unknown.text


def test_mapping_chunk() -> None:
    facts = MappingFacts(
        source_id="s1",
        source_name="crm_export",
        column="ph",
        target="phone",
        role="field",
        confidence=0.95,
        label="High",
        reason="Column name and values look like phone numbers",
        transform="normalise_phone",
        method="hybrid",
        decision="accept",
        decided_target="phone",
        decided_at=AT,
    )
    chunk = mapping_chunk(P, facts)
    assert chunk.id == "mapping:s1:ph"
    assert chunk.refs == {"sourceId": "s1", "column": "ph"}
    assert "maps to the target field phone, High confidence (0.95), suggested by hybrid" in (
        chunk.text
    )
    assert "Transform hint: normalise_phone." in chunk.text
    assert "Decision: accept (target phone) on 2026-11-23" in chunk.text
    pending = mapping_chunk(
        P, replace(facts, role="ignore", target=None, decision=None, reason=None, method=None)
    )
    assert "is proposed as ignore (not mapped to a target field)" in pending.text
    assert "Decision: waiting for review." in pending.text


def test_quality_chunks_have_one_per_rule_of_the_latest_run_only() -> None:
    latest = QualityRunFacts(
        run_id="q2",
        finished_at=AT,
        status="fail",
        source_label="Approved SQL version 1",
        row_count=130,
        status_counts={"fail": 1, "pass": 1},
        results=(
            rule(),
            rule(rule="row_count_change", label="Rows changed", field=None, status="skipped",
                 metric=None, unit="percent", warn=None, fail=None, counts={},
                 example_ids=(), message="No earlier check to compare with."),
            rule(rule="sql_run_freshness", label="Hours since run", field=None, status="pass",
                 metric=2.0, unit="hours", direction="max", warn=24.0, fail=None),
        ),
    )  # fmt: skip
    earlier = replace(latest, run_id="q1", status="pass", status_counts={}, results=())
    chunks = quality_chunks(P, [latest, earlier])
    assert [c.id for c in chunks] == [
        "quality:q2",
        "quality:q2:completeness_optional:pin_code",
        "quality:q2:row_count_change",
        "quality:q2:sql_run_freshness",
        "quality:q1",
    ]
    overview, pin, skipped, fresh, old = chunks
    assert overview.title == "Latest quality check: fail"
    assert "Rules: 1 fail, 1 pass." in overview.text
    assert "- Optional field filled in (pin_code): fail, 61.5%" in overview.text
    assert old.title == "Earlier quality check: pass"
    assert "Rules: none." in old.text
    assert pin.refs == {"ruleId": "completeness_optional:pin_code", "column": "pin_code"}
    assert "Measured 61.5%; warn unless at least 90, fail unless at least 70." in pin.text
    assert "Counts: empty 50, filled 80." in pin.text
    assert "Example customers: C1, C2." in pin.text
    assert "not measured; no threshold" in skipped.text
    assert "Outcome: No earlier check to compare with." in skipped.text
    assert "Measured 2 hours; warn unless at most 24." in fresh.text


def test_sql_chunk() -> None:
    facts = SqlVersionFacts(
        version_id="v1",
        version=3,
        status="approved",
        method="llm",
        scope="all",
        explanation="Joins golden records.",
        assumptions=("Every customer has a golden record",),
        tests_passed=False,
        checks=(
            SqlCheckFacts("columns", "passed", "All columns."),
            SqlCheckFacts("row_count", "failed", "2 rows missing."),
        ),
        fallback_reason=None,
        last_run="130 rows, passed its tests",
        created_at=AT,
    )
    chunk = sql_chunk(P, facts)
    assert chunk.refs == {"sqlVersionId": "v1"}
    assert "for all customers and was written by the AI SQL agent on" in chunk.text
    assert "Assumption: Every customer has a golden record" in chunk.text
    assert "Automatic tests: 1 of 2 passed; the version did not pass every test." in chunk.text
    assert "- row_count: failed. 2 rows missing." in chunk.text
    assert "Latest run: 130 rows, passed its tests." in chunk.text
    reference = sql_chunk(
        P,
        replace(facts, method="reference", fallback_reason="LLM_DISABLED", explanation="",
                checks=(), tests_passed=True, last_run=None),
    )  # fmt: skip
    assert "the reference query (LLM_DISABLED)" in reference.text
    assert "No explanation stored." in reference.text
    assert "Automatic tests: 0 of 0 passed." in reference.text


def test_docs_are_split_by_heading_and_length() -> None:
    long = "\n\n".join(f"Paragraph {i} " + "word " * 60 for i in range(12))
    text = (
        "Intro line before any heading.\n"
        "# ADR 0015: Blocking\n\n## Context\n\nWhy blocking.\n\n## Decision\n\n"
        f"{long}\n\n## Decision\n\nAgain.\n\n### Notes\n"
    )
    chunks = doc_chunks(P, DocFile("docs/adr/0015-blocking.md", text))
    titles = [c.title for c in chunks]
    assert titles[0] == "ADR 0015: Blocking: Introduction"
    assert titles[1] == "ADR 0015: Blocking: Context"
    assert "ADR 0015: Blocking: Decision (part 2)" in titles
    assert all(c.refs == {"adr": "0015"} for c in chunks)
    assert all(len(c.text) <= MAX_DOC_CHARS for c in chunks)
    assert len({c.id for c in chunks}) == len(chunks)
    assert chunks[1].link == Link(
        "docs", {"path": "docs/adr/0015-blocking.md", "section": "context"}
    )
    readme = doc_chunks(P, DocFile("README.md", "## Setup\n\nRun it."))
    assert readme[0].refs == {}
    assert readme[0].title == "README.md: Setup"


def test_content_hash_follows_what_is_shown() -> None:
    chunk = customer_chunk(P, customer())
    assert chunk.content_hash == customer_chunk(P, customer()).content_hash
    assert chunk.content_hash != replace(chunk, text=chunk.text + ".").content_hash
    assert chunk.content_hash == replace(chunk, updated_at=None).content_hash


# ---- privacy guard


def _chunk(kind: str, text: str, title: str = "Title") -> Chunk:
    return Chunk(f"{kind}:1", P, kind, title, text, {}, Link("dashboard"))  # type: ignore[arg-type]


def test_guard_drops_data_chunks_with_staged_values_or_pii_patterns() -> None:
    guard = PrivacyGuard.from_records(RECORDS, PII)
    assert guard.value_count > 0
    result = guard.screen(
        [
            _chunk("customer", "Customer C1 has 2 records."),
            _chunk("customer", "Name word asha appears."),
            _chunk("decision", "Reason: mail someone@example.com"),
            _chunk("quality", "Pune is a city, not personal here."),
            _chunk("docs", "Example: Asha Rao called 98200 12345 from Pune."),
        ]
    )
    assert result.dropped == 2
    assert result.masked == 1
    assert [c.kind for c in result.kept] == ["customer", "quality", "docs"]
    docs = result.kept[-1].text
    assert MASKED_VALUE in docs
    assert "Asha Rao" not in docs
    assert "12345" not in docs
    assert guard.leaks(result.kept) == 0
    assert guard.leaks([_chunk("docs", "Asha Rao"), _chunk("mapping", "rao")]) == 2


def test_guard_without_a_schema_checks_every_field() -> None:
    guard = PrivacyGuard.from_records(RECORDS, ["full_name"])
    assert not guard.holds_value("Pune")
    assert guard.holds_value("asha")
    everything = PrivacyGuard({"pune"})
    assert everything.holds_value("City Pune")
    assert not everything.holds_value("Pune123")


def test_build_chunks_screens_and_counts() -> None:
    guard = PrivacyGuard.from_records(RECORDS, PII)
    facts = ProjectFacts(
        customers=[customer()],
        decisions=[decision("cluster.split", reason="Asha is someone else")],
        docs=[DocFile("README.md", "## Setup\n\nRun it.")],
    )
    chunks, screened = build_chunks(P, facts, guard)
    assert screened.dropped == 0
    split = next(c for c in chunks if c.kind == "decision")
    assert "Asha" not in split.text
    assert counts_by_kind(chunks) == {
        "customer": 1, "decision": 1, "mapping": 0, "quality": 0, "sql": 0, "docs": 1
    }  # fmt: skip


# ---- retrieval


def test_tokenize_stems_and_drops_stop_words() -> None:
    assert tokenize("Who approved the approvals of customers?") == [
        "approv",
        "approval",
        "customer",
    ]
    assert tokenize("Approve merging studies 2026") == ["approv", "merg", "study", "2026"]
    assert tokenize("pass class") == ["pass", "class"]


def test_bm25_prefers_rare_matching_terms() -> None:
    bm25 = BM25([["pin", "code", "fail"], ["email", "pass"], ["pin", "pin", "email"]])
    scores = bm25.scores(["pin", "fail"])
    assert scores[0] > scores[2] > scores[1] == 0
    assert BM25([]).scores(["x"]) == []


def _indexed(*texts: str, vectors: bool = True) -> list[Indexed]:
    items = []
    for index, text in enumerate(texts):
        chunk = Chunk(f"c{index}", P, "docs", f"T{index}", text, {"adr": f"{index:04d}"},
                      Link("docs"))  # fmt: skip
        items.append(Indexed(chunk, hashed_vector(text) if vectors else None))
    return items


def test_search_fuses_keyword_and_vector_rankings() -> None:
    items = _indexed(
        "How duplicates are found with blocking keys",
        "Golden record survivorship rules",
        "Quality thresholds warn and fail",
    )
    keyword = search(items, "duplicates blocking", None, k=2)
    assert keyword.mode == "keyword"
    assert [h.chunk.id for h in keyword.hits] == ["c0"]
    assert keyword.hits[0].vector_rank is None
    hybrid = search(items, "duplicates blocking", hashed_vector("duplicates blocking"), k=2)
    assert hybrid.mode == "hybrid"
    assert hybrid.hits[0].chunk.id == "c0"
    assert hybrid.hits[0].keyword_rank == 1
    assert hybrid.hits[0].vector_rank == 1
    assert len(hybrid.hits) == 2
    assert hybrid.hits[0].score > hybrid.hits[1].score


def test_search_filters_and_falls_back_to_keywords() -> None:
    items = _indexed("blocking keys", "blocking rules", vectors=False)
    assert search(items, "blocking", [1.0, 0.0]).mode == "keyword"
    mixed = [items[0], Indexed(items[1].chunk, [1.0, 0.0])]
    assert search(mixed, "blocking", [1.0, 0.0, 0.0]).mode == "keyword"
    only = search(items, "blocking", None, refs={"adr": "0001"})
    assert [h.chunk.id for h in only.hits] == ["c1"]
    assert search(items, "blocking", None, kinds=frozenset({"sql"})).hits == []
    assert search(items, "nothing matches", None).hits == []
    assert cosine([0.0, 0.0], [1.0, 0.0]) == 0.0


# ---- incremental embedding


class CountingEmbedder:
    def __init__(self, fail_after: int | None = None) -> None:
        self.calls: list[list[str]] = []
        self.fail_after = fail_after

    async def embed(
        self, texts: Sequence[str], *, kind: EmbeddingKind = "document",
        project_id: str | None = None,
    ) -> EmbeddingResponse:  # fmt: skip
        if self.fail_after is not None and len(self.calls) >= self.fail_after:
            raise LLMRateLimitError("429", code=429, status="RESOURCE_EXHAUSTED")
        self.calls.append(list(texts))
        return EmbeddingResponse(
            vectors=[hashed_vector(t) for t in texts], model="m", input_tokens=1, latency_ms=0
        )


async def test_unchanged_chunks_keep_their_vectors() -> None:
    chunks = [_chunk("docs", f"text {i}") for i in range(4)]
    chunks = [replace(c, id=f"docs:{i}") for i, c in enumerate(chunks)]
    stored = {
        "docs:0": StoredVector(chunks[0].content_hash, [1.0], "m"),
        "docs:1": StoredVector("old-hash", [1.0], "m"),
        "docs:2": StoredVector(chunks[2].content_hash, [1.0], "other-model"),
        "docs:3": StoredVector(chunks[3].content_hash, [1.0, 2.0], "m"),
    }
    embedder = CountingEmbedder()
    progress: list[tuple[int, int]] = []
    result = await embed_chunks(
        P, chunks, stored, embedder, "m", on_batch=lambda d, t: progress.append((d, t)),
        batch_size=1, dimensions=1,
    )  # fmt: skip
    assert result.reused == 1
    assert result.embedded == 3
    assert result.vectors["docs:0"] == [1.0]
    assert len(embedder.calls) == 3
    assert progress == [(1, 3), (2, 3), (3, 3)]
    assert result.mode(chunks) == "hybrid"


async def test_an_embedding_failure_keeps_what_was_done() -> None:
    chunks = [replace(_chunk("docs", f"text {i}"), id=f"docs:{i}") for i in range(3)]
    result = await embed_chunks(P, chunks, {}, CountingEmbedder(fail_after=1), "m", batch_size=1)
    assert result.error == "429 RESOURCE_EXHAUSTED"
    assert result.embedded == 1
    assert result.mode(chunks) == "keyword"
    nothing = await embed_chunks(P, chunks, {}, None, "m")
    assert nothing == Embedded()
    assert Embedded().mode([]) == "keyword"
