"""Chunk builders: plain-language, value-free passages about one project (ADR 0024).

Pure functions, no I/O. Each builder turns facts the pipeline already stores (ids, field and
source names, rule names, codes, counts, statuses and reasons in words) into ``Chunk``s. No
builder ever receives a record value: the inputs below have no field for one. The privacy guard
(``app.knowledge.privacy``) still scans every chunk before it is indexed.

Kinds: ``customer`` (one per multi-record cluster), ``decision`` (one per audit entry of a
person), ``mapping`` (one per source column), ``quality`` (one per rule of the latest run, one
overview per recent run), ``sql`` (one per SQL version) and ``docs`` (README and ADR sections).
"""

import hashlib
import json
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

ChunkKind = Literal["customer", "decision", "mapping", "quality", "sql", "docs"]
KINDS: tuple[ChunkKind, ...] = ("customer", "decision", "mapping", "quality", "sql", "docs")
REF_KEYS: tuple[str, ...] = ("customerId", "sourceId", "column", "ruleId", "sqlVersionId", "adr")

# Longest docs chunk, in characters; a longer section is split at paragraph breaks.
MAX_DOC_CHARS = 1_500
RULE_WORDS: Mapping[str, str] = {
    "most_frequent": "most frequent",
    "most_complete": "most complete",
    "most_typical": "most typical",
    "source_trust": "most trusted source",
    "most_recent": "most recent",
    "only_value": "only value",
}
PASSED = frozenset({"pass", "passed"})
ACTION_TITLES: Mapping[str, str] = {
    "mapping.decide": "Mapping decision",
    "mapping.accept_high": "Mapping decision: high-confidence columns accepted",
    "cluster.approve": "Match decision: customer approved",
    "cluster.unapprove": "Match decision: approval undone",
    "cluster.approve_high": "Match decision: high-confidence customers approved",
    "cluster.split": "Match decision: customer split",
    "cluster.merge": "Match decision: customers merged",
    "sql_version.approve": "SQL decision: version approved",
    "sql_version.reject": "SQL decision: version rejected",
    "sql_version.run": "SQL decision: version run",
    "quality_rules.update": "Quality decision: rules changed",
    "export.download": "Export decision: export downloaded",
    "export.delete": "Export decision: export deleted",
    "job.create": "Export decision: export requested",
}
LINK_KIND_WORDS: Mapping[str, str] = {
    "match": "linked by the match score",
    "ai_suggested": "linked on the AI review's suggestion",
    "human": "linked by a person's decision",
}


@dataclass(frozen=True)
class Link:
    """Where the assistant can send the user: a web page slug and its query parameters."""

    page: str
    params: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class Chunk:
    id: str
    project_id: str
    kind: ChunkKind
    title: str
    text: str
    refs: Mapping[str, str]
    link: Link
    updated_at: datetime | None = None

    @property
    def content_hash(self) -> str:
        """sha256 of what is embedded and shown: a changed hash means a new embedding."""
        payload = {
            "kind": self.kind,
            "title": self.title,
            "text": self.text,
            "refs": dict(sorted(self.refs.items())),
            "link": {"page": self.link.page, "params": dict(sorted(self.link.params.items()))},
        }
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        return hashlib.sha256(encoded).hexdigest()

    @property
    def embedding_text(self) -> str:
        return f"{self.title}\n{self.text}"


# ---- inputs (filled by app.knowledge.store from MongoDB, or by the eval from the pipeline)


@dataclass(frozen=True)
class RecordRef:
    """Where a record came from: never its values."""

    record_id: str
    source_name: str
    row_number: int | None


@dataclass(frozen=True)
class PairLink:
    """One link that holds a cluster together, with the scoring and AI review explanation."""

    record_a: str
    record_b: str
    kind: str
    score: float | None
    reasons: tuple[str, ...] = ()
    ai_decision: str | None = None
    ai_confidence: float | None = None
    ai_reason: str | None = None


@dataclass(frozen=True)
class FieldOrigin:
    """Which record and rule chose a golden field (``record_id`` None: no member had one)."""

    field: str
    rule: str | None
    record_id: str | None


@dataclass(frozen=True)
class CustomerFacts:
    customer_id: str
    size: int
    confidence: float | None
    label: str | None
    flags: tuple[str, ...]
    guard_reasons: tuple[str, ...]
    approved: bool
    members: tuple[RecordRef, ...]
    links: tuple[PairLink, ...]
    origins: tuple[FieldOrigin, ...]
    updated_at: datetime | None = None


@dataclass(frozen=True)
class DecisionFacts:
    """One audit entry. ``details`` holds only ids, enums and counts (see ``SAFE_DETAILS``)."""

    entry_id: str
    action: str
    actor_role: str
    at: datetime | None
    entity_type: str
    entity_id: str
    details: Mapping[str, Any]
    reason: str | None = None
    source_name: str | None = None


@dataclass(frozen=True)
class MappingFacts:
    source_id: str
    source_name: str
    column: str
    target: str | None
    role: str
    confidence: float | None
    label: str | None
    reason: str | None
    transform: str | None
    method: str | None
    decision: str | None = None
    decided_target: str | None = None
    decided_role: str | None = None
    decided_at: datetime | None = None
    updated_at: datetime | None = None


@dataclass(frozen=True)
class RuleFacts:
    rule: str
    label: str
    field: str | None
    status: str
    metric: float | None
    unit: str | None
    direction: str | None
    warn: float | None
    fail: float | None
    message: str
    counts: Mapping[str, int]
    example_ids: tuple[str, ...]


@dataclass(frozen=True)
class QualityRunFacts:
    run_id: str
    finished_at: datetime | None
    status: str
    source_label: str
    row_count: int
    status_counts: Mapping[str, int]
    results: tuple[RuleFacts, ...]


@dataclass(frozen=True)
class SqlCheckFacts:
    name: str
    status: str
    message: str


@dataclass(frozen=True)
class SqlVersionFacts:
    version_id: str
    version: int
    status: str
    method: str
    scope: str
    explanation: str
    assumptions: tuple[str, ...]
    tests_passed: bool
    checks: tuple[SqlCheckFacts, ...]
    fallback_reason: str | None
    last_run: str | None
    created_at: datetime | None


@dataclass(frozen=True)
class DocFile:
    """A Markdown file to index: ``path`` relative to the repository (e.g. docs/adr/0015-...)."""

    path: str
    text: str


# ---- helpers


def _when(at: datetime | None) -> str:
    return at.strftime("%Y-%m-%d %H:%M UTC") if at else "an unknown time"


def _confidence(value: float | None, label: str | None) -> str:
    if value is None and label is None:
        return "no confidence (a single record)"
    if value is None:
        return f"{label} confidence"
    return f"{label or 'unrated'} confidence ({value:.2f})"


def _words(code: str) -> str:
    return code.replace("_", " ").replace(".", " ")


def _record(ref: RecordRef | None, record_id: str) -> str:
    if ref is None:
        return f"record {record_id}"
    row = f" row {ref.row_number}" if ref.row_number is not None else ""
    return f"{ref.source_name}{row}"


# ---- customer


def customer_chunk(project_id: str, facts: CustomerFacts) -> Chunk:
    by_id = {m.record_id: m for m in facts.members}
    sources = sorted({m.source_name for m in facts.members})
    status = "approved by a reviewer" if facts.approved else "proposed, not yet approved"
    lines = [
        f"Customer {facts.customer_id} was merged from {facts.size} records "
        f"({', '.join(sources)}). Match confidence: "
        f"{_confidence(facts.confidence, facts.label)}. Review status: {status}.",
        f"Flags: {', '.join(_words(f) for f in facts.flags) if facts.flags else 'none'}.",
    ]
    lines += [f"Warning: {reason}." for reason in facts.guard_reasons]
    if facts.links:
        lines.append("Why these records were merged:")
    for link in facts.links:
        pair = f"{_record(by_id.get(link.record_a), link.record_a)} and " + _record(
            by_id.get(link.record_b), link.record_b
        )
        why = "; ".join(link.reasons) or "no field comparison stored"
        score = f", match score {link.score:.2f}" if link.score is not None else ""
        line = f"- {pair}: {why} ({LINK_KIND_WORDS.get(link.kind, _words(link.kind))}{score})."
        if link.ai_decision:
            confidence = (
                f", confidence {link.ai_confidence:.2f}" if link.ai_confidence is not None else ""
            )
            reason = f": {link.ai_reason}" if link.ai_reason else ""
            line += f" AI review: {_words(link.ai_decision)}{confidence}{reason}."
        lines.append(line)
    if facts.origins:
        lines.append("How each golden record field was chosen:")
    for origin in facts.origins:
        if origin.record_id is None:
            lines.append(f"- {origin.field}: empty, no member record had a value.")
            continue
        rule = RULE_WORDS.get(origin.rule or "", _words(origin.rule or "unknown rule"))
        source = _record(by_id.get(origin.record_id), origin.record_id)
        lines.append(f"- {origin.field} from {source} by {rule}.")
    return Chunk(
        id=f"customer:{facts.customer_id}",
        project_id=project_id,
        kind="customer",
        title=f"Customer {facts.customer_id}: {facts.size} records merged",
        text="\n".join(lines),
        refs={"customerId": facts.customer_id},
        link=Link("matching", {"customerId": facts.customer_id}),
        updated_at=facts.updated_at,
    )


# ---- decision

# ``after`` keys an audit entry may contribute: ids, enums and counts only.
SAFE_DETAILS: frozenset[str] = frozenset(
    {
        "column",
        "decision",
        "target",
        "role",
        "sourceId",
        "size",
        "label",
        "customerIds",
        "recordId",
        "sizes",
        "decisions",
        "approved",
        "accepted",
        "skipped",
        "type",
        "format",
        "version",
        "status",
        "scope",
        "jobId",
        "rowCount",
    }
)


def _decision_sentence(facts: DecisionFacts) -> tuple[str, Link, dict[str, str]]:
    d, entity = facts.details, facts.entity_id
    action = facts.action
    if action == "mapping.decide":
        column = str(d.get("column") or entity.partition(":")[2])
        source = facts.source_name or str(d.get("sourceId") or "a source")
        target = f" (target field {d['target']})" if d.get("target") else ""
        text = (
            f"Mapping decision: column {column} of source {source} was "
            f"{_words(str(d.get('decision') or 'decided'))}{target}"
        )
        refs = {"column": column, **({"sourceId": str(d["sourceId"])} if "sourceId" in d else {})}
        return text, Link("mapping", refs), refs
    if action == "mapping.accept_high":
        source = facts.source_name or entity
        count = d.get("accepted")
        text = f"Mapping decision: every high-confidence column of source {source} was accepted"
        text += f" ({count} columns)" if count is not None else ""
        return text, Link("mapping", {"sourceId": entity}), {"sourceId": entity}
    if action.startswith("cluster."):
        return _match_sentence(facts)
    if action.startswith("sql_version."):
        verb = {"approve": "approved", "reject": "rejected", "run": "run"}.get(
            action.partition(".")[2], action.partition(".")[2]
        )
        version = f" {d['version']}" if d.get("version") is not None else ""
        text = f"SQL decision: SQL version{version} ({entity}) was {verb}"
        refs = {"sqlVersionId": entity}
        return text, Link("pipeline", {"versionId": entity}), refs
    if action == "quality_rules.update":
        return "Quality rules (thresholds) of the project were changed", Link("quality"), {}
    if action.startswith("export."):
        verb = "downloaded" if action == "export.download" else "deleted"
        kind = f" {d['format']}" if d.get("format") else ""
        return f"Export decision: the{kind} export {entity} was {verb}", Link("pipeline"), {}
    if action == "job.create" and d.get("type") == "export":
        return "Export decision: a golden-record export was requested", Link("pipeline"), {}
    return f"{_words(action)} on {facts.entity_type} {entity}", Link("dashboard"), {}


def _match_sentence(facts: DecisionFacts) -> tuple[str, Link, dict[str, str]]:
    d, customer = facts.details, facts.entity_id
    verb = facts.action.partition(".")[2]
    refs = {"customerId": customer}
    if verb == "approve":
        size = f" ({d['size']} records, {d.get('label') or 'unrated'} confidence)"
        text = f"Match decision: customer {customer} was approved" + (size if d.get("size") else "")
    elif verb == "unapprove":
        text = f"Match decision: the approval of customer {customer} was undone"
    elif verb == "approve_high":
        count = d.get("approved")
        text = "Match decision: every high-confidence customer was approved"
        text += f" ({count} customers)" if count is not None else ""
        refs = {}
    elif verb == "split":
        record = d.get("recordId")
        text = f"Match decision: customer {customer} was split by hand" + (
            f", record {record} taken out" if record else ""
        )
    elif verb == "merge":
        ids = [str(i) for i in d.get("customerIds") or []]
        text = f"Match decision: customers {' and '.join(ids) or customer} were merged by hand"
    else:
        text = f"Match decision: {_words(verb)} on customer {customer}"
    return text, Link("matching", refs), refs


def decision_chunk(
    project_id: str, facts: DecisionFacts, reason_allowed: Callable[[str], bool]
) -> Chunk:
    """``reason_allowed`` decides whether a person's reason text may be kept (it is dropped
    when it looks like personal data)."""
    sentence, link, refs = _decision_sentence(facts)
    text = f"{sentence} by a {_words(facts.actor_role)} on {_when(facts.at)}."
    reason = (facts.reason or "").strip()
    if reason and reason_allowed(reason):
        text += f" Reason given: {reason}"
    elif reason:
        text += " A reason was given but is not shown (it may hold personal data)."
    return Chunk(
        id=f"decision:{facts.entry_id}",
        project_id=project_id,
        kind="decision",
        title=ACTION_TITLES.get(facts.action, f"Decision: {_words(facts.action)}"),
        text=text,
        refs=refs,
        link=link,
        updated_at=facts.at,
    )


# ---- mapping


def mapping_chunk(project_id: str, facts: MappingFacts) -> Chunk:
    if facts.role == "field" and facts.target:
        proposal = f"maps to the target field {facts.target}"
    else:
        proposal = f"is proposed as {_words(facts.role)} (not mapped to a target field)"
    lines = [
        f"Column {facts.column} of source {facts.source_name} {proposal}, "
        f"{_confidence(facts.confidence, facts.label)}"
        + (f", suggested by {facts.method}" if facts.method else "")
        + "."
    ]
    if facts.reason:
        lines.append(f"Reason: {facts.reason}")
    if facts.transform:
        lines.append(f"Transform hint: {facts.transform}.")
    if facts.decision:
        chosen = facts.decided_target or _words(facts.decided_role or "")
        lines.append(
            f"Decision: {_words(facts.decision)}"
            + (f" (target {chosen})" if chosen else "")
            + f" on {_when(facts.decided_at)}."
        )
    else:
        lines.append("Decision: waiting for review.")
    refs = {"sourceId": facts.source_id, "column": facts.column}
    return Chunk(
        id=f"mapping:{facts.source_id}:{facts.column}",
        project_id=project_id,
        kind="mapping",
        title=f"Mapping of column {facts.column} ({facts.source_name})",
        text="\n".join(lines),
        refs=refs,
        link=Link("mapping", refs),
        updated_at=facts.decided_at or facts.updated_at,
    )


# ---- quality


def _metric(rule: RuleFacts) -> str:
    if rule.metric is None:
        return "not measured"
    unit = "%" if rule.unit == "percent" else f" {rule.unit or ''}".rstrip()
    return f"{rule.metric:g}{unit}"


def _threshold(rule: RuleFacts) -> str:
    if rule.warn is None and rule.fail is None:
        return "no threshold"
    side = "at least" if rule.direction == "min" else "at most"
    parts = []
    if rule.warn is not None:
        parts.append(f"warn unless {side} {rule.warn:g}")
    if rule.fail is not None:
        parts.append(f"fail unless {side} {rule.fail:g}")
    return ", ".join(parts)


def rule_id(rule: RuleFacts) -> str:
    return f"{rule.rule}:{rule.field}" if rule.field else rule.rule


def quality_chunks(project_id: str, runs: Sequence[QualityRunFacts]) -> list[Chunk]:
    """Newest run first: one chunk per rule of the newest run, one overview per run."""
    chunks: list[Chunk] = []
    for position, run in enumerate(runs):
        counts = ", ".join(f"{n} {s}" for s, n in sorted(run.status_counts.items()))
        failing = [r for r in run.results if r.status in ("fail", "warn")]
        lines = [
            f"{'Latest' if position == 0 else 'Earlier'} quality check result: overall "
            f"{run.status} on {_when(run.finished_at)} (check {run.run_id}), {run.row_count} "
            f"rows of {run.source_label}. Rules: {counts or 'none'}."
        ]
        lines += [
            f"- {r.label}{f' ({r.field})' if r.field else ''}: {r.status}, {_metric(r)}"
            for r in failing
        ]
        latest = position == 0
        chunks.append(
            Chunk(
                id=f"quality:{run.run_id}",
                project_id=project_id,
                kind="quality",
                title=f"{'Latest' if latest else 'Earlier'} quality check: {run.status}",
                text="\n".join(lines),
                refs={},
                link=Link("quality", {"runId": run.run_id}),
                updated_at=run.finished_at,
            )
        )
        if latest:
            chunks += [_rule_chunk(project_id, run, rule) for rule in run.results]
    return chunks


def _rule_chunk(project_id: str, run: QualityRunFacts, rule: RuleFacts) -> Chunk:
    on = f" of {rule.field}" if rule.field else ""
    counts = ", ".join(f"{_words(k)} {v}" for k, v in sorted(rule.counts.items()))
    lines = [
        f"Quality rule {rule.label}{on} ({rule.rule}): {rule.status}. "
        f"Measured {_metric(rule)}; {_threshold(rule)}.",
        f"Outcome: {rule.message}",
    ]
    if counts:
        lines.append(f"Counts: {counts}.")
    if rule.example_ids:
        lines.append(f"Example customers: {', '.join(rule.example_ids)}.")
    identifier = rule_id(rule)
    return Chunk(
        id=f"quality:{run.run_id}:{identifier}",
        project_id=project_id,
        kind="quality",
        title=f"Quality rule {rule.label}{on}: {rule.status}",
        text="\n".join(lines),
        refs={"ruleId": identifier, **({"column": rule.field} if rule.field else {})},
        link=Link("quality", {"runId": run.run_id, "rule": identifier}),
        updated_at=run.finished_at,
    )


# ---- sql


def sql_chunk(project_id: str, facts: SqlVersionFacts) -> Chunk:
    passed = sum(1 for c in facts.checks if c.status in PASSED)
    lines = [
        f"SQL version {facts.version} ({facts.version_id}) is {facts.status}. It builds the "
        f"customer table for {'all' if facts.scope == 'all' else 'approved'} customers and was "
        f"written by {'the AI SQL agent' if facts.method == 'llm' else 'the reference query'}"
        + (f" ({facts.fallback_reason})" if facts.fallback_reason else "")
        + f" on {_when(facts.created_at)}.",
        f"Explanation: {facts.explanation}" if facts.explanation else "No explanation stored.",
    ]
    lines += [f"Assumption: {a}" for a in facts.assumptions]
    lines.append(
        f"Automatic tests: {passed} of {len(facts.checks)} passed"
        + ("." if facts.tests_passed else "; the version did not pass every test.")
    )
    lines += [
        f"- {c.name}: {c.status}. {c.message}" for c in facts.checks if c.status not in PASSED
    ]
    if facts.last_run:
        lines.append(f"Latest run: {facts.last_run}.")
    return Chunk(
        id=f"sql:{facts.version_id}",
        project_id=project_id,
        kind="sql",
        title=f"SQL version {facts.version}: {facts.status}",
        text="\n".join(lines),
        refs={"sqlVersionId": facts.version_id},
        link=Link("pipeline", {"versionId": facts.version_id}),
        updated_at=facts.created_at,
    )


# ---- docs

_HEADING = re.compile(r"^(#{1,3})\s+(.+?)\s*$")
_ADR_NUMBER = re.compile(r"(\d{4})-")
_SLUG = re.compile(r"[^a-z0-9]+")


def doc_chunks(project_id: str, doc: DocFile) -> list[Chunk]:
    """A file split at its headings (levels 1-3); a long section split again at paragraph
    breaks into parts of at most ``MAX_DOC_CHARS``."""
    name = doc.path.rsplit("/", 1)[-1]
    adr_match = _ADR_NUMBER.match(name)
    adr = adr_match.group(1) if adr_match else None
    doc_title = name
    sections: list[tuple[str, list[str]]] = []
    for line in doc.text.splitlines():
        found = _HEADING.match(line)
        if found and found.group(1) == "#" and doc_title == name:
            doc_title = found.group(2)
            continue
        if found:
            sections.append((found.group(2), []))
        elif sections:
            sections[-1][1].append(line)
        else:
            sections.append(("Introduction", [line]))
    chunks: list[Chunk] = []
    used: set[str] = set()
    for heading, lines in sections:
        for index, part in enumerate(_parts("\n".join(lines).strip())):
            slug = _SLUG.sub("-", heading.lower()).strip("-") or "section"
            key = f"{slug}-{index}" if index else slug
            while key in used:
                key += "-x"
            used.add(key)
            suffix = f" (part {index + 1})" if index else ""
            refs = {"adr": adr} if adr else {}
            chunks.append(
                Chunk(
                    id=f"docs:{name}:{key}",
                    project_id=project_id,
                    kind="docs",
                    title=f"{doc_title}: {heading}{suffix}",
                    text=part,
                    refs=refs,
                    link=Link("docs", {"path": doc.path, "section": slug}),
                )
            )
    return chunks


def _parts(text: str) -> list[str]:
    if not text:
        return []
    parts: list[str] = []
    current = ""
    for paragraph in re.split(r"\n\s*\n", text):
        if current and len(current) + len(paragraph) + 2 > MAX_DOC_CHARS:
            parts.append(current)
            current = paragraph
        else:
            current = f"{current}\n\n{paragraph}" if current else paragraph
    if current:
        parts.append(current)
    return parts
