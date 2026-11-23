"""MongoDB access of the knowledge index (ADR 0024).

Reads what the pipeline stored: ``clusters``, ``golden_records``, ``cluster_summaries``,
``cluster_approvals``, ``score_summaries``, ``pair_scores``, ``staged_records``, ``sources``,
``target_schemas``, ``mapping_suggestions``, ``mapping_decisions``, ``quality_runs``,
``sql_versions``, ``audit_logs``, ``projects`` and ``users``, and turns each into the value-free
facts of ``app.knowledge.chunks``. Record values are read in one place only, ``pii_records``,
for the privacy guard. Writes ``knowledge_chunks`` (one document per chunk, keyed by project
and chunk id) and ``knowledge_summaries`` (one per project).
"""

from collections.abc import Iterable, Iterator, Mapping
from datetime import UTC, datetime
from typing import Any

from bson import ObjectId
from pymongo import ASCENDING, DESCENDING

from app.export.store import ExportStore
from app.knowledge.chunks import (
    SAFE_DETAILS,
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
from app.profiling.store import Document

CHUNKS_COLLECTION = "knowledge_chunks"
SUMMARIES_COLLECTION = "knowledge_summaries"
# Audit actions that are a person's decision about the data (ADR 0023's review counts).
DECISION_ACTIONS: tuple[str, ...] = (
    "mapping.decide",
    "mapping.accept_high",
    "cluster.approve",
    "cluster.unapprove",
    "cluster.approve_high",
    "cluster.split",
    "cluster.merge",
    "sql_version.approve",
    "sql_version.reject",
    "sql_version.run",
    "quality_rules.update",
    "export.download",
    "export.delete",
    "job.create",
)


def _aware(value: object) -> datetime | None:
    """MongoDB returns naive UTC datetimes."""
    if not isinstance(value, datetime):
        return None
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def _float(value: object) -> float | None:
    return float(value) if isinstance(value, int | float) else None


def _safe(value: object) -> object:
    """Ids, enums and counts as JSON-like values (ObjectIds become strings)."""
    if isinstance(value, ObjectId):
        return str(value)
    if isinstance(value, list):
        return [_safe(v) for v in value]
    return value


class KnowledgeStore(ExportStore):
    _knowledge_indexed = False

    # ---- privacy guard input

    def pii_fields(self, project_id: str) -> set[str]:
        """Fields the target schema marks ``is_pii``; without a schema every field is
        treated as personal (the guard then checks more, never less)."""
        schema = self.target_schema(project_id)
        if schema is None:
            return {"*"}
        return {f.name for f in schema.fields if f.is_pii}

    def pii_records(self, project_id: str, fields: set[str]) -> Iterator[dict[str, str | None]]:
        cursor = self._db["staged_records"].find({"projectId": ObjectId(project_id)}, {"fields": 1})
        for doc in cursor:
            values = doc.get("fields") or {}
            yield {
                k: (None if v is None else str(v))
                for k, v in values.items()
                if "*" in fields or k in fields
            }

    # ---- customers

    def customers(self, project_id: str) -> list[CustomerFacts]:
        summary = self.cluster_summary(project_id)
        if summary is None:
            return []
        project, run_id = ObjectId(project_id), str(summary["runId"])
        clusters = list(
            self._db["clusters"]
            .find({"projectId": project, "runId": run_id, "size": {"$gt": 1}})
            .sort("position", ASCENDING)
        )
        if not clusters:
            return []
        approved = self.approved_ids(project_id)
        origins = {
            str(doc["customerId"]): doc.get("provenance") or {}
            for doc in self._db["golden_records"].find(
                {"projectId": project, "runId": run_id}, {"customerId": 1, "provenance": 1}
            )
        }
        member_ids = [m for c in clusters for m in c.get("memberRecordIds") or []]
        sources = self.source_names(project_id)
        refs = {
            str(doc["_id"]): RecordRef(
                str(doc["_id"]),
                sources.get(str(doc.get("sourceId")), "an unknown source"),
                int(doc["rowNumber"]) if doc.get("rowNumber") is not None else None,
            )
            for doc in self.staged(project_id, member_ids)
        }
        pairs = self._pair_scores(project_id)
        finished = _aware(summary.get("finishedAt"))
        return [self._customer(c, refs, pairs, origins, approved, finished) for c in clusters]

    def _pair_scores(self, project_id: str) -> dict[frozenset[str], Document]:
        summary = self._db["score_summaries"].find_one({"projectId": ObjectId(project_id)})
        if summary is None:
            return {}
        cursor = self._db["pair_scores"].find(
            {"projectId": ObjectId(project_id), "runId": summary.get("runId")},
            {
                "recordA": 1,
                "recordB": 1,
                "reasons": 1,
                "aiDecision": 1,
                "aiConfidence": 1,
                "aiReason": 1,
            },
        )
        return {frozenset((str(d["recordA"]), str(d["recordB"]))): d for d in cursor}

    @staticmethod
    def _customer(
        cluster: Document,
        refs: Mapping[str, RecordRef],
        pairs: Mapping[frozenset[str], Document],
        origins: Mapping[str, Mapping[str, Any]],
        approved: set[str],
        finished: datetime | None,
    ) -> CustomerFacts:
        customer = str(cluster["customerId"])
        members = tuple(
            refs.get(str(i), RecordRef(str(i), "an unknown source", None))
            for i in cluster.get("memberRecordIds") or []
        )
        links: list[PairLink] = []
        for link in cluster.get("links") or []:
            if not link.get("tree", True):
                continue
            a, b = str(link["recordA"]), str(link["recordB"])
            scored = pairs.get(frozenset((a, b))) or {}
            links.append(
                PairLink(
                    record_a=a,
                    record_b=b,
                    kind=str(link.get("kind") or "match"),
                    score=_float(link.get("score")),
                    reasons=tuple(str(r.get("text")) for r in scored.get("reasons") or []),
                    ai_decision=scored.get("aiDecision"),
                    ai_confidence=_float(scored.get("aiConfidence")),
                    ai_reason=scored.get("aiReason"),
                )
            )
        provenance = origins.get(customer, {})
        return CustomerFacts(
            customer_id=customer,
            size=int(cluster.get("size") or len(members)),
            confidence=_float(cluster.get("confidence")),
            label=cluster.get("label"),
            flags=tuple(cluster.get("flags") or ()),
            guard_reasons=tuple(cluster.get("reasons") or ()),
            approved=customer in approved,
            members=members,
            links=tuple(links),
            origins=tuple(
                FieldOrigin(
                    name,
                    choice.get("rule"),
                    str(choice["recordId"]) if choice.get("recordId") else None,
                )
                for name, choice in provenance.items()
            ),
            updated_at=finished,
        )

    # ---- decisions

    def decisions(self, project_id: str) -> list[DecisionFacts]:
        project = ObjectId(project_id)
        entries = list(
            self._db["audit_logs"]
            .find(
                {"projectId": project, "actorType": "user", "action": {"$in": DECISION_ACTIONS}},
                {"before": 0},
            )
            .sort("createdAt", DESCENDING)
        )
        roles = self._roles(project_id, {str(e.get("actorId")) for e in entries})
        sources = self.source_names(project_id)
        facts: list[DecisionFacts] = []
        for entry in entries:
            after = entry.get("after") or {}
            if entry["action"] == "job.create" and after.get("type") != "export":
                continue
            details = {k: _safe(after[k]) for k in sorted(SAFE_DETAILS) if k in after}
            source_id = str(details.get("sourceId") or "")
            if entry["action"] == "mapping.accept_high":
                source_id = str(entry.get("entityId"))
            reason = after.get("reason")
            facts.append(
                DecisionFacts(
                    entry_id=str(entry["_id"]),
                    action=str(entry["action"]),
                    actor_role=roles.get(str(entry.get("actorId")), "former member"),
                    at=_aware(entry.get("createdAt")),
                    entity_type=str(entry.get("entityType") or ""),
                    entity_id=str(entry.get("entityId") or ""),
                    details=details,
                    reason=reason if isinstance(reason, str) else None,
                    source_name=sources.get(source_id),
                )
            )
        return facts

    def _roles(self, project_id: str, user_ids: set[str]) -> dict[str, str]:
        """The actor's relation to the project now: owner, member role, admin."""
        project = self._db["projects"].find_one(
            {"_id": ObjectId(project_id)}, {"ownerId": 1, "members": 1}
        )
        roles: dict[str, str] = {}
        ids = [ObjectId(u) for u in user_ids if ObjectId.is_valid(u)]
        for user in self._db["users"].find({"_id": {"$in": ids}}, {"role": 1}):
            if user.get("role") == "admin":
                roles[str(user["_id"])] = "admin"
        if project is not None:
            for member in project.get("members") or []:
                roles[str(member["userId"])] = str(member.get("role"))
            roles[str(project.get("ownerId"))] = "project owner"
        return roles

    # ---- mappings

    def mappings(self, project_id: str) -> list[MappingFacts]:
        project = ObjectId(project_id)
        sources = self.source_names(project_id)
        decisions = {
            (str(d["sourceId"]), str(d["column"])): d
            for d in self._db["mapping_decisions"].find({"projectId": project})
        }
        facts: list[MappingFacts] = []
        cursor = (
            self._db["mapping_suggestions"]
            .find({"projectId": project})
            .sort([("sourceId", ASCENDING), ("position", ASCENDING)])
        )
        for doc in cursor:
            source_id, column = str(doc["sourceId"]), str(doc["column"])
            suggestion = doc.get("suggestion") or {}
            decision = decisions.get((source_id, column)) or {}
            facts.append(
                MappingFacts(
                    source_id=source_id,
                    source_name=sources.get(source_id, "an unknown source"),
                    column=column,
                    target=suggestion.get("target"),
                    role=str(suggestion.get("role") or "field"),
                    confidence=_float(suggestion.get("confidence")),
                    label=suggestion.get("confidenceLabel"),
                    reason=suggestion.get("reason"),
                    transform=suggestion.get("transform"),
                    method=doc.get("method"),
                    decision=decision.get("decision"),
                    decided_target=decision.get("target"),
                    decided_role=decision.get("role"),
                    decided_at=_aware(decision.get("decidedAt")),
                    updated_at=_aware(doc.get("createdAt")),
                )
            )
        return facts

    # ---- quality and SQL

    def quality_runs(self, project_id: str, limit: int) -> list[QualityRunFacts]:
        cursor = (
            self._db["quality_runs"]
            .find({"projectId": ObjectId(project_id)})
            .sort([("startedAt", DESCENDING), ("_id", DESCENDING)])
            .limit(limit)
        )
        return [_quality_run(doc) for doc in cursor]

    def sql_versions(self, project_id: str) -> list[SqlVersionFacts]:
        cursor = (
            self._db["sql_versions"]
            .find({"projectId": ObjectId(project_id)}, {"sql": 0, "attempts": 0})
            .sort("version", DESCENDING)
        )
        return [_sql_version(doc) for doc in cursor]

    # ---- the index

    def stored(self, project_id: str) -> dict[str, Document]:
        """chunk id -> its content hash, vector and embedding model."""
        cursor = self._db[CHUNKS_COLLECTION].find(
            {"projectId": ObjectId(project_id)},
            {"chunkId": 1, "contentHash": 1, "vector": 1, "embeddingModel": 1},
        )
        return {str(doc["chunkId"]): doc for doc in cursor}

    def save_chunks(
        self,
        project_id: str,
        job_id: str,
        rows: Iterable[tuple[Chunk, list[float] | None, str | None]],
    ) -> int:
        """Upsert every chunk (with its vector), then delete the project's other chunks;
        returns how many were deleted."""
        self._ensure_knowledge_indexes()
        project, now = ObjectId(project_id), self.now()
        collection = self._db[CHUNKS_COLLECTION]
        keep: list[str] = []
        for chunk, vector, model in rows:
            keep.append(chunk.id)
            document: Document = {
                "projectId": project,
                "chunkId": chunk.id,
                "kind": chunk.kind,
                "title": chunk.title,
                "text": chunk.text,
                "refs": dict(chunk.refs),
                "link": {"page": chunk.link.page, "params": dict(chunk.link.params)},
                "updatedAt": chunk.updated_at,
                "contentHash": chunk.content_hash,
                "vector": vector,
                "embeddingModel": model if vector is not None else None,
                "jobId": ObjectId(job_id),
                "indexedAt": now,
            }
            collection.replace_one(
                {"projectId": project, "chunkId": chunk.id}, document, upsert=True
            )
        removed = collection.delete_many({"projectId": project, "chunkId": {"$nin": keep}})
        return removed.deleted_count

    def save_summary(self, project_id: str, summary: Document) -> None:
        project = ObjectId(project_id)
        self._db[SUMMARIES_COLLECTION].replace_one(
            {"projectId": project}, {"projectId": project, **summary}, upsert=True
        )

    def summary(self, project_id: str) -> Document | None:
        return self._db[SUMMARIES_COLLECTION].find_one({"projectId": ObjectId(project_id)})

    def _ensure_knowledge_indexes(self) -> None:
        if self._knowledge_indexed:
            return
        self._db[CHUNKS_COLLECTION].create_index(
            [("projectId", ASCENDING), ("chunkId", ASCENDING)], unique=True
        )
        self._db[SUMMARIES_COLLECTION].create_index([("projectId", ASCENDING)], unique=True)
        self._knowledge_indexed = True


def _quality_run(doc: Document) -> QualityRunFacts:
    source = doc.get("source") or {}
    return QualityRunFacts(
        run_id=str(doc["_id"]),
        finished_at=_aware(doc.get("finishedAt")),
        status=str(doc.get("status") or "unknown"),
        source_label=str(source.get("label") or "the customer table"),
        row_count=int(doc.get("rowCount") or 0),
        status_counts={str(k): int(v) for k, v in (doc.get("statusCounts") or {}).items()},
        results=tuple(_rule(r) for r in doc.get("results") or []),
    )


def _rule(result: Mapping[str, Any]) -> RuleFacts:
    threshold = result.get("threshold") or {}
    return RuleFacts(
        rule=str(result.get("rule")),
        label=str(result.get("label") or result.get("rule")),
        field=result.get("field"),
        status=str(result.get("status")),
        metric=_float(result.get("metric")),
        unit=result.get("unit"),
        direction=result.get("direction"),
        warn=_float(threshold.get("warn")),
        fail=_float(threshold.get("fail")),
        message=str(result.get("message") or ""),
        counts={str(k): int(v) for k, v in (result.get("counts") or {}).items()},
        example_ids=tuple(str(i) for i in result.get("exampleIds") or []),
    )


def _sql_version(doc: Document) -> SqlVersionFacts:
    tests = doc.get("tests") or {}
    last = doc.get("lastRun") or None
    last_run = None
    if isinstance(last, Mapping):
        passed = "passed its tests" if last.get("passed") else "did not pass its tests"
        rows = last.get("rowCount")
        when = _aware(last.get("finishedAt") or last.get("createdAt"))
        last_run = (f"{rows} rows, {passed}" if rows is not None else passed) + (
            f", on {when.strftime('%Y-%m-%d %H:%M UTC')}" if when else ""
        )
    return SqlVersionFacts(
        version_id=str(doc["_id"]),
        version=int(doc.get("version") or 0),
        status=str(doc.get("status") or "draft"),
        method=str(doc.get("method") or "reference"),
        scope=str(doc.get("scope") or "approved"),
        explanation=str(doc.get("explanation") or ""),
        assumptions=tuple(str(a) for a in doc.get("assumptions") or []),
        tests_passed=bool(doc.get("testsPassed")),
        checks=tuple(
            SqlCheckFacts(str(c.get("name")), str(c.get("status")), str(c.get("message") or ""))
            for c in tests.get("checks") or []
        ),
        fallback_reason=doc.get("fallbackReason"),
        last_run=last_run,
        created_at=_aware(doc.get("createdAt")),
    )
