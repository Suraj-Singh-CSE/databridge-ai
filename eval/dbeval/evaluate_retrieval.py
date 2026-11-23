"""Evaluate the knowledge index's retrieval (ADR 0024) on the seed 42 samples.

Builds what a project holds after the whole pipeline, with the ai-service's pure code (no
MongoDB): rules mapping suggestions per source, clusters and golden records with provenance
(``evaluate_golden``'s pipeline, keeping the pair scores' reasons), the reference SQL version
and its tests, a quality run of the final table, a hand-written audit trail (approvals, a split
with a reason, an SQL approval, a rule change, an export) and the README and ADRs. Then:

1. **Privacy guard.** Every chunk is screened against the staged values of the ``is_pii``
   fields and the gateway's PII patterns; the finished index is scanned again and must hold
   no staged value (``leaks``).
2. **Retrieval.** A hand-written set of questions, each with the chunks that answer it, is
   searched keyword-only (BM25) and hybrid (BM25 + Mock embeddings through the gateway, fused
   with RRF). Reports recall@1/@3/@5 and MRR for both.

    python -m dbeval.evaluate_retrieval                       # the committed samples
    python -m dbeval.evaluate_retrieval --data <dataset dir>  # another set (samples layout)

Only ids, counts and metrics are printed, never values or chunk text. Exits non-zero when the
index leaks a value or the privacy guard drops a chunk on the samples.
"""

import argparse
import asyncio
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from app.config import Settings
from app.knowledge.chunks import (
    Chunk,
    CustomerFacts,
    DecisionFacts,
    FieldOrigin,
    MappingFacts,
    PairLink,
    QualityRunFacts,
    RecordRef,
    RuleFacts,
    SqlCheckFacts,
    SqlVersionFacts,
)
from app.knowledge.docs import load_docs
from app.knowledge.index import (
    Embedder,
    ProjectFacts,
    build_chunks,
    counts_by_kind,
    embed_chunks,
)
from app.knowledge.privacy import GuardResult, PrivacyGuard
from app.knowledge.retrieval import Indexed, search
from app.llm.base import LLMProvider
from app.llm.cache import InMemoryCache
from app.llm.cost import InMemoryCostLogger
from app.llm.gateway import LLMGateway
from app.llm.mock import MockProvider
from app.mapping.models import TargetSchema
from app.matching.blocking import candidate_pairs
from app.matching.clustering import Cluster, MemberRecord, ScoredPair, cluster_records
from app.matching.scoring import PairScore, score_pairs
from app.matching.survivorship import SurvivorshipConfig, golden_record, source_rank
from app.privacy.masking import PIIMasker
from app.quality.rules import RuleResult
from app.sql.agent import draft_reference
from app.sql.sandbox import Sandbox, SandboxLimits
from pydantic import SecretStr

from dbeval.evaluate_blocking import load_records
from dbeval.evaluate_golden import SOURCE_ORDER
from dbeval.evaluate_mapping import SAMPLES, SOURCE_FILES, load_schema, map_source, profile_source
from dbeval.evaluate_quality import check, pipeline_table
from dbeval.evaluate_sql_agent import sandbox_data

PROJECT = "0" * 24
REPO = Path(__file__).resolve().parents[2]
AT = datetime(2026, 11, 23, 10, 0, tzinfo=UTC)
QUALITY_RUN = "q" * 24
SQL_VERSION = "5" * 24
SOURCE_IDS = {name: f"{index + 1:024x}" for index, name in enumerate(SOURCE_FILES)}
KS = (1, 3, 5)


@dataclass(frozen=True)
class Question:
    text: str
    expected: frozenset[str]


@dataclass(frozen=True)
class Built:
    chunks: list[Chunk]
    screened: GuardResult
    guard: PrivacyGuard
    questions: list[Question]


@dataclass(frozen=True)
class ModeMetrics:
    mode: str
    recall: dict[int, float]
    mrr: float
    ranks: list[int | None]


# ---- the project's facts, from the pure pipeline


def _clusters(
    data: Path,
) -> tuple[list[Cluster], dict[str, MemberRecord], dict[frozenset[str], PairScore]]:
    loaded, _person_of = load_records(data)
    members: dict[str, MemberRecord] = {}
    for record in loaded:
        row_number = int(record.id.rsplit(":", 1)[1])
        members[record.id] = MemberRecord(
            id=record.id,
            key=f"{record.source}:{record.source_record_id or row_number}",
            source=record.source,
            source_order=SOURCE_ORDER[record.source],
            row_number=row_number,
            fields=record.fields,
        )
    blocked = candidate_pairs(loaded)
    scored = score_pairs(
        [(p.record_a, p.record_b) for p in blocked.pairs], {r.id: r.fields for r in loaded}
    )
    pairs = [ScoredPair(p.record_a, p.record_b, p.score, p.band) for p in scored.scores]
    clusters = cluster_records(list(members.values()), pairs)
    return clusters, members, {frozenset((p.record_a, p.record_b)): p for p in scored.scores}


def customers(data: Path, schema: TargetSchema) -> list[CustomerFacts]:
    clusters, members, scores = _clusters(data)
    fields = [f.name for f in schema.fields if not f.generated]
    trust = SurvivorshipConfig().source_trust
    ranks = {source: source_rank(source, None, trust) for source in SOURCE_FILES}
    facts: list[CustomerFacts] = []
    for cluster in clusters:
        if cluster.size < 2:
            continue
        golden = golden_record(cluster, members, fields, ranks)
        refs = tuple(
            RecordRef(m, f"{members[m].source}_export", members[m].row_number)
            for m in cluster.member_ids
        )
        links = tuple(
            PairLink(
                link.record_a,
                link.record_b,
                link.kind,
                link.score,
                tuple(r.text for r in scores[frozenset((link.record_a, link.record_b))].reasons)
                if frozenset((link.record_a, link.record_b)) in scores
                else (),
            )
            for link in cluster.links
            if link.tree
        )
        facts.append(
            CustomerFacts(
                customer_id=cluster.customer_id,
                size=cluster.size,
                confidence=cluster.confidence,
                label=cluster.label,
                flags=cluster.flags,
                guard_reasons=cluster.reasons,
                approved=not cluster.needs_review,
                members=refs,
                links=links,
                origins=tuple(
                    FieldOrigin(name, choice.rule, choice.record_id)
                    for name, choice in golden.provenance.items()
                ),
                updated_at=AT,
            )
        )
    return facts


def mappings(data: Path, schema: TargetSchema) -> list[MappingFacts]:
    facts: list[MappingFacts] = []
    for source in SOURCE_FILES:
        for s in map_source("rules", profile_source(data, source), schema):
            facts.append(
                MappingFacts(
                    source_id=SOURCE_IDS[source],
                    source_name=f"{source}_export",
                    column=s.column,
                    target=s.target,
                    role=s.role,
                    confidence=s.confidence,
                    label=s.confidence_label,
                    reason=s.reason,
                    transform=s.transform,
                    method="rules",
                    decision="accept",
                    decided_target=s.target,
                    decided_role=s.role,
                    decided_at=AT,
                )
            )
    return facts


def _rule(result: RuleResult) -> RuleFacts:
    document = result.to_document()
    threshold = document["threshold"] or {}
    return RuleFacts(
        rule=result.rule,
        label=document["label"],
        field=result.field,
        status=result.status,
        metric=document["metric"],
        unit=document["unit"],
        direction=document["direction"],
        warn=threshold.get("warn"),
        fail=threshold.get("fail"),
        message=result.message,
        counts=dict(result.counts),
        example_ids=tuple(document["exampleIds"]),
    )


def quality(data: Path) -> QualityRunFacts:
    results = list(check(pipeline_table(data)).values())
    counts: dict[str, int] = {}
    for result in results:
        counts[result.status] = counts.get(result.status, 0) + 1
    worst = next((s for s in ("fail", "warn") if counts.get(s)), "pass")
    return QualityRunFacts(
        run_id=QUALITY_RUN,
        finished_at=AT,
        status=worst,
        source_label="Golden records of the approved customers (no approved SQL version)",
        row_count=len(pipeline_table(data).rows),
        status_counts=counts,
        results=tuple(_rule(r) for r in results),
    )


def sql_version(data: Path) -> SqlVersionFacts:
    box_data = sandbox_data(data)
    with Sandbox.load(box_data, SandboxLimits()) as box:
        outcome = draft_reference(box, "approved", reason=None)
    tests = outcome.evaluation.tests
    return SqlVersionFacts(
        version_id=SQL_VERSION,
        version=1,
        status="approved",
        method=outcome.method,
        scope="approved",
        explanation=outcome.explanation,
        assumptions=outcome.assumptions,
        tests_passed=outcome.evaluation.passed,
        checks=tuple(
            SqlCheckFacts(c.name, c.status, c.message) for c in (tests.checks if tests else ())
        ),
        fallback_reason=outcome.fallback_reason,
        last_run=None,
        created_at=AT,
    )


def decisions(people: Sequence[CustomerFacts]) -> list[DecisionFacts]:
    first, second, third = (p.customer_id for p in people[:3])

    def entry(number: int, action: str, entity: str, role: str, **details: object) -> DecisionFacts:
        reason = details.pop("reason", None)
        return DecisionFacts(
            entry_id=f"audit-{number}",
            action=action,
            actor_role=role,
            at=AT,
            entity_type=action.split(".")[0],
            entity_id=entity,
            details=details,
            reason=reason if isinstance(reason, str) else None,
        )

    return [
        entry(1, "cluster.approve", first, "data_steward", size=people[0].size, label="High"),
        entry(2, "cluster.approve", second, "data_steward", size=people[1].size, label="High"),
        entry(3, "cluster.split", third, "data_steward", recordId="support:0000007",
              reason="Different people at the same address"),
        entry(4, "cluster.merge", first, "data_engineer", customerIds=[first, second],
              reason="Call the customer on +91 98200 12345 to confirm"),
        entry(5, "sql_version.approve", SQL_VERSION, "data_engineer", version=1),
        entry(6, "quality_rules.update", PROJECT, "project owner"),
        entry(7, "export.download", "e" * 24, "data_steward", format="csv"),
    ]  # fmt: skip


def project_facts(data: Path) -> tuple[ProjectFacts, PrivacyGuard]:
    schema = load_schema(data / "answers")
    people = customers(data, schema)
    facts = ProjectFacts(
        customers=people,
        decisions=decisions(people),
        mappings=mappings(data, schema),
        quality_runs=[quality(data)],
        sql_versions=[sql_version(data)],
        docs=load_docs(REPO),
    )
    loaded, _ = load_records(data)
    pii = {f.name for f in schema.fields if f.is_pii}
    guard = PrivacyGuard.from_records((r.fields for r in loaded), pii)
    return facts, guard


# ---- questions


def questions(facts: ProjectFacts, chunks: Sequence[Chunk]) -> list[Question]:
    people = list(facts.customers)
    biggest = max(people, key=lambda p: (p.size, p.customer_id))
    second, third = people[1], people[2]

    def adr(number: str) -> frozenset[str]:
        return frozenset(c.id for c in chunks if c.refs.get("adr") == number)

    def mapped(source: str, target: str) -> tuple[str, frozenset[str]]:
        found = next(m for m in facts.mappings if m.source_name == source and m.target == target)
        return found.column, frozenset({f"mapping:{found.source_id}:{found.column}"})

    def rule(rule_id: str) -> frozenset[str]:
        return frozenset({f"quality:{QUALITY_RUN}:{rule_id}"})

    crm_name, crm_name_chunk = mapped("crm_export", "full_name")
    _, billing_phone = mapped("billing_export", "phone")
    customer = "customer:{}".format
    return [
        Question("Why did PIN completeness fail?", rule("completeness_optional:pin_code")),
        Question("Is the email filled in for every customer?", rule("completeness_optional:email")),
        Question("Are phone numbers in the expected format?", rule("validity:phone")),
        Question("Does the city match the PIN code region?", rule("city_pin_consistency:city")),
        Question("Are customer ids unique?", rule("customer_id_unique:customer_id")),
        Question("What was the result of the latest quality check?",
                 frozenset({f"quality:{QUALITY_RUN}"})),
        Question(f"Why were these records merged into {biggest.customer_id}?",
                 frozenset({customer(biggest.customer_id)})),
        Question(f"How was the full_name of customer {second.customer_id} chosen?",
                 frozenset({customer(second.customer_id)})),
        Question(f"Which sources does customer {third.customer_id} come from?",
                 frozenset({customer(third.customer_id)})),
        Question("Who approved the SQL?", frozenset({"decision:audit-5"})),
        Question(f"Why was customer {third.customer_id} split?", frozenset({"decision:audit-3"})),
        Question(f"Who approved customer {second.customer_id}?", frozenset({"decision:audit-2"})),
        Question("Who changed the quality rules?", frozenset({"decision:audit-6"})),
        Question("Which customers were merged by hand?", frozenset({"decision:audit-4"})),
        Question("Was the export downloaded?", frozenset({"decision:audit-7"})),
        Question(f"What does the column {crm_name} map to?", crm_name_chunk),
        Question("Which billing column holds the phone?", billing_phone),
        Question("Which automatic tests did the SQL version pass?",
                 frozenset({f"sql:{SQL_VERSION}"})),
        Question("What assumptions does the SQL query make?", frozenset({f"sql:{SQL_VERSION}"})),
        Question("How are duplicates found?", adr("0015")),
        Question("How is personal data kept away from the AI model?", adr("0006")),
        Question("How are golden record values chosen when records disagree?", adr("0018")),
        Question("How do the data quality thresholds work?", adr("0022")),
    ]  # fmt: skip


# ---- running


def build(data: Path) -> Built:
    facts, guard = project_facts(data)
    chunks, screened = build_chunks(PROJECT, facts, guard)
    return Built(chunks, screened, guard, questions(facts, chunks))


def mock_gateway() -> LLMGateway:
    return gateway_for(MockProvider(), eval_settings())


def eval_settings() -> Settings:
    return Settings(
        _env_file=None,
        ai_service_token=SecretStr("evaluation-only-token"),
        redis_url="redis://unused",
        mongodb_uri="mongodb://unused",
    )


def gateway_for(
    provider: LLMProvider, settings: Settings, costs: InMemoryCostLogger | None = None
) -> LLMGateway:
    return LLMGateway(
        provider, InMemoryCache(), costs or InMemoryCostLogger(), PIIMasker(), settings
    )


def rank_of(hits: Sequence[Chunk], expected: frozenset[str]) -> int | None:
    return next((i for i, c in enumerate(hits, start=1) if c.id in expected), None)


def measure(mode: str, ranks: list[int | None]) -> ModeMetrics:
    total = len(ranks) or 1
    recall = {k: sum(1 for r in ranks if r is not None and r <= k) / total for k in KS}
    mrr = sum(1 / r for r in ranks if r is not None) / total
    return ModeMetrics(mode, recall, mrr, ranks)


async def evaluate(
    built: Built, embedder: Embedder, model: str | None
) -> tuple[ModeMetrics, ModeMetrics, int]:
    """Keyword-only and hybrid metrics, and how many chunks got a vector."""
    embedded = await embed_chunks(PROJECT, built.chunks, {}, embedder, model)
    items = [Indexed(c, embedded.vectors.get(c.id)) for c in built.chunks]
    texts = [q.text for q in built.questions]
    query_vectors = (await embedder.embed(texts, kind="query", project_id=PROJECT)).vectors
    keyword: list[int | None] = []
    hybrid: list[int | None] = []
    for question, vector in zip(built.questions, query_vectors, strict=True):
        alone = search(items, question.text, None, k=max(KS))
        both = search(items, question.text, vector, k=max(KS))
        keyword.append(rank_of([h.chunk for h in alone.hits], question.expected))
        hybrid.append(rank_of([h.chunk for h in both.hits], question.expected))
    return measure("keyword", keyword), measure("hybrid", hybrid), len(embedded.vectors)


def metrics_table(rows: Sequence[ModeMetrics]) -> str:
    lines = [
        "| Mode | Recall@1 | Recall@3 | Recall@5 | MRR |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    for row in rows:
        lines.append(
            f"| {row.mode} | {row.recall[1]:.2f} | {row.recall[3]:.2f} | {row.recall[5]:.2f} | "
            f"{row.mrr:.2f} |"
        )
    return "\n".join(lines)


def ranks_table(built: Built, rows: Sequence[ModeMetrics]) -> str:
    def shown(rank: int | None) -> str:
        return "-" if rank is None else str(rank)

    lines = ["| # | Expected | Keyword rank | Hybrid rank |", "| ---: | --- | ---: | ---: |"]
    for index, question in enumerate(built.questions):
        kind = sorted(question.expected)[0].split(":", 1)[0] if question.expected else "-"
        lines.append(
            f"| {index + 1} | {kind} | {shown(rows[0].ranks[index])} | "
            f"{shown(rows[1].ranks[index])} |"
        )
    return "\n".join(lines)


def privacy_lines(built: Built) -> list[str]:
    by_kind = ", ".join(f"{k} {n}" for k, n in counts_by_kind(built.chunks).items())
    return [
        f"Chunks: {len(built.chunks)} ({by_kind})",
        f"Privacy guard: {built.screened.dropped} dropped, {built.screened.masked} docs chunks "
        f"masked, {built.guard.leaks(built.chunks)} chunks holding a staged value "
        f"({built.guard.value_count:,} values checked)",
    ]


def main(argv: Sequence[str] | None = None, *, data_default: Path = SAMPLES) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--data", type=Path, default=data_default, help="dataset folder")
    args = parser.parse_args(argv)
    built = build(args.data)
    gateway = mock_gateway()
    keyword, hybrid, _ = asyncio.run(evaluate(built, gateway, MockProvider.embedding_model))
    for line in privacy_lines(built):
        print(line)
    print(f"Questions: {len(built.questions)}")
    print()
    print(metrics_table([keyword, hybrid]))
    print()
    print(ranks_table(built, [keyword, hybrid]))
    leaks = built.guard.leaks(built.chunks)
    return 0 if leaks == 0 and built.screened.dropped == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
