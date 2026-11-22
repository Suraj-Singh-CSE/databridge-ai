"""Clustering: union-find over match links, confidence on the spanning tree, chaining guard."""

import pytest

from app.matching.clustering import (
    REASON_DIFFERENT_PEOPLE,
    Cluster,
    ClusteringConfig,
    MemberRecord,
    PairDecision,
    ScoredPair,
    cluster_records,
    customer_id,
    label_of,
    links_of,
)

ASHA = {"full_name": "Asha Rao", "phone": "+919820012345", "date_of_birth": "1990-01-02"}
OTHER = {"full_name": "Asha Rao", "phone": "+919811111111", "date_of_birth": "1975-06-07"}


def member(i: str, fields: dict[str, str | None] | None = None, order: int = 0) -> MemberRecord:
    return MemberRecord(i, f"src:{i}", "crm", order, int(i[1:]), fields or dict(ASHA))


def records(n: int) -> list[MemberRecord]:
    return [member(f"r{i}") for i in range(1, n + 1)]


def match(a: str, b: str, score: float = 0.99) -> ScoredPair:
    return ScoredPair(a, b, score, "match")


def by_member(clusters: list[Cluster], record: str) -> Cluster:
    return next(c for c in clusters if record in c.member_ids)


def test_connected_components_and_singletons() -> None:
    clusters = cluster_records(records(5), [match("r1", "r2"), match("r2", "r3")])

    assert [c.member_ids for c in clusters] == [("r1", "r2", "r3"), ("r4",), ("r5",)]
    assert [c.size for c in clusters] == [3, 1, 1]
    single = clusters[1]
    assert (single.confidence, single.label, single.flags, single.links) == (None, None, (), ())


def test_confidence_is_the_weakest_link_of_the_maximum_spanning_tree() -> None:
    pairs = [match("r1", "r2", 0.999), match("r2", "r3", 0.95), match("r1", "r3", 0.98)]

    (cluster,) = cluster_records(records(3), pairs)

    # r1-r2 (0.999) and r1-r3 (0.98) hold the cluster; the weaker r2-r3 is not needed.
    assert cluster.confidence == 0.98
    assert cluster.label == "High"
    tree = {(link.record_a, link.record_b) for link in cluster.links if link.tree}
    assert tree == {("r1", "r2"), ("r1", "r3")}
    assert len(cluster.links) == 3


@pytest.mark.parametrize(
    ("value", "label"),
    [
        (None, None),
        (0.999, "High"),
        (0.97, "High"),
        (0.95, "Medium"),
        (0.9, "Medium"),
        (0.6, "Low"),
    ],
)
def test_labels(value: float | None, label: str | None) -> None:
    assert label_of(value) == label


def test_maybe_and_non_match_pairs_do_not_link() -> None:
    pairs = [ScoredPair("r1", "r2", 0.7, "maybe"), ScoredPair("r2", "r3", 0.01, "non_match")]
    assert all(c.size == 1 for c in cluster_records(records(3), pairs))


def test_ai_suggested_links_are_marked_and_can_be_turned_off() -> None:
    pairs = [ScoredPair("r1", "r2", 0.7, "maybe", "match"), match("r3", "r4")]

    clusters = cluster_records(records(4), pairs)

    joined = by_member(clusters, "r1")
    assert joined.member_ids == ("r1", "r2")
    assert joined.ai_suggested is True
    assert joined.label == "Low"
    assert by_member(clusters, "r3").ai_suggested is False
    strict = cluster_records(records(4), pairs, config=ClusteringConfig(include_ai_suggested=False))
    assert by_member(strict, "r1").size == 1


def test_a_persons_decisions_win() -> None:
    pairs = [match("r1", "r2"), ScoredPair("r3", "r4", 0.1, "non_match")]
    decisions = [PairDecision("r2", "r1", "different"), PairDecision("r4", "r3", "same")]

    clusters = cluster_records(records(4), pairs, decisions)

    assert by_member(clusters, "r1").size == 1
    joined = by_member(clusters, "r3")
    assert joined.member_ids == ("r3", "r4")
    assert [(link.kind, link.score) for link in joined.links] == [("human", 1.0)]
    # The person said same: the non_match score inside no longer flags the cluster.
    assert joined.flags == ()


def test_links_ignore_unknown_records_and_keep_the_strongest_order() -> None:
    links = links_of([match("r2", "r1", 0.95), match("r3", "r4", 0.99)])
    assert [(link.record_a, link.record_b) for link in links] == [("r3", "r4"), ("r1", "r2")]
    (cluster, *_) = cluster_records(records(2), [match("r1", "r9")])
    assert cluster.size == 1


def test_chaining_guard_flags_a_non_match_inside_without_splitting() -> None:
    pairs = [match("r1", "r2"), match("r2", "r3"), ScoredPair("r1", "r3", 0.01, "non_match")]

    (cluster,) = cluster_records(records(3), pairs)

    assert cluster.size == 3
    assert cluster.flags == ("needs_review", "different_people")
    assert cluster.needs_review
    assert cluster.reasons == (f"{REASON_DIFFERENT_PEOPLE} (1 pair scored as not a match)",)


def test_chaining_guard_flags_conflicting_birth_dates_and_phones() -> None:
    members = [member("r1"), member("r2"), member("r3", OTHER)]
    pairs = [match("r1", "r2"), match("r2", "r3")]

    (cluster,) = cluster_records(members, pairs)

    assert cluster.flags == ("needs_review", "conflicting_evidence")
    assert "different birth dates and different phones (2 pairs)" in cluster.reasons[0]
    missing = [member("r1"), member("r2", {"full_name": "Asha Rao"})]
    assert cluster_records(missing, [match("r1", "r2")])[0].flags == ()


def test_chaining_guard_flags_large_clusters() -> None:
    pairs = [match(f"r{i}", f"r{i + 1}") for i in range(1, 7)]

    (cluster,) = cluster_records(records(7), pairs)

    assert cluster.flags == ("needs_review", "too_large")
    assert cluster.reasons == ("Unusually large: 7 records (more than 6)",)
    roomy = cluster_records(records(7), pairs, config=ClusteringConfig(max_cluster_size=7))
    assert roomy[0].flags == ()
    with pytest.raises(ValueError, match="at least 2"):
        ClusteringConfig(max_cluster_size=1)


def test_customer_ids_depend_on_membership_only() -> None:
    first = cluster_records(records(3), [match("r1", "r2")])
    shuffled = cluster_records(list(reversed(records(3))), [match("r2", "r1")])
    assert {c.customer_id for c in first} == {c.customer_id for c in shuffled}
    assert customer_id(["a", "b"]) == customer_id(["b", "a"]) != customer_id(["a"])
    assert customer_id(["a"]).startswith("C")
    assert len(customer_id(["a"])) == 13


def test_members_are_ordered_by_upload_then_row() -> None:
    members = [member("r1", order=1), member("r2", order=0)]
    (cluster,) = cluster_records(members, [match("r1", "r2")])
    assert cluster.member_ids == ("r2", "r1")


def test_a_customer_id_collision_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.matching.clustering.customer_id", lambda _keys: "C000000000000")
    with pytest.raises(ValueError, match="collision"):
        cluster_records(records(2), [])
