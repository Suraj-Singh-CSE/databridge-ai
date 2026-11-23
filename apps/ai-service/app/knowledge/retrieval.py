"""Hybrid retrieval over a project's chunks: BM25 keywords plus embedding cosine (ADR 0024).

Pure functions, no I/O. The two rankings are combined with reciprocal rank fusion (RRF: each
list adds ``1 / (RRF_K + rank)``), which needs no score calibration between them. Without a
query vector, or when no chunk has a vector of the same length, the search is keyword-only and
says so (``mode: "keyword"``).
"""

import math
import re
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

from app.knowledge.chunks import Chunk

SearchMode = Literal["hybrid", "keyword"]
RRF_K = 60
# Each ranking contributes at most this many chunks to the fusion.
RANK_DEPTH = 50
BM25_K1 = 1.2
BM25_B = 0.75
# A title counts this many times in the keyword index: it names what the chunk is about.
TITLE_WEIGHT = 2

_WORD = re.compile(r"[a-z0-9]+")
_STOPWORD_TEXT = (
    "a an and are as at be been by did do does for from had has have how i in into is it "
    "its me my of on or our so that the their them these this those to was we were what "
    "when where which who whom why will with you your"
)
_STOPWORDS = frozenset(_STOPWORD_TEXT.split())


def tokenize(text: str) -> list[str]:
    """Lower-case words without stop words, lightly stemmed ("approved", "approve" and
    "approves" all become "approv")."""
    return [_stem(word) for word in _WORD.findall(text.lower()) if word not in _STOPWORDS]


def _stem(word: str) -> str:
    if len(word) <= 3 or word.isdigit():
        return word
    if word.endswith("ies") and len(word) > 4:
        word = word[:-3] + "y"
    elif word.endswith("s") and not word.endswith("ss"):
        word = word[:-1]
    for suffix in ("ing", "ed"):
        if word.endswith(suffix) and len(word) - len(suffix) >= 3:
            word = word[: -len(suffix)]
            break
    if word.endswith("e") and len(word) > 4:
        word = word[:-1]
    return word


def chunk_tokens(chunk: Chunk) -> list[str]:
    """What the keyword index sees: title (weighted), text and the refs' values (ids, column
    and rule names), so "C00A1" or "pin_code" find their chunk."""
    refs = " ".join(f"{v} {v.replace('_', ' ')}" for v in chunk.refs.values())
    return tokenize(chunk.title) * TITLE_WEIGHT + tokenize(chunk.text) + tokenize(refs)


class BM25:
    """Okapi BM25 over pre-tokenized documents."""

    def __init__(self, documents: Sequence[Sequence[str]]) -> None:
        self._counts = [Counter(doc) for doc in documents]
        self._lengths = [len(doc) for doc in documents]
        self._average = (sum(self._lengths) / len(documents)) if documents else 0.0
        frequency: Counter[str] = Counter()
        for counts in self._counts:
            frequency.update(counts.keys())
        total = len(documents)
        self._idf = {
            term: math.log(1 + (total - n + 0.5) / (n + 0.5)) for term, n in frequency.items()
        }

    def scores(self, query: Sequence[str]) -> list[float]:
        terms = [t for t in dict.fromkeys(query) if t in self._idf]
        result: list[float] = []
        for counts, length in zip(self._counts, self._lengths, strict=True):
            score = 0.0
            norm = BM25_K1 * (1 - BM25_B + BM25_B * length / (self._average or 1.0))
            for term in terms:
                tf = counts.get(term, 0)
                if tf:
                    score += self._idf[term] * tf * (BM25_K1 + 1) / (tf + norm)
            result.append(score)
        return result


def cosine(a: Sequence[float], b: Sequence[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    norm = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return dot / norm if norm else 0.0


@dataclass(frozen=True)
class Indexed:
    chunk: Chunk
    vector: Sequence[float] | None = None


@dataclass(frozen=True)
class Hit:
    chunk: Chunk
    score: float
    keyword_rank: int | None
    vector_rank: int | None


@dataclass(frozen=True)
class SearchResult:
    hits: list[Hit]
    mode: SearchMode


def matches(chunk: Chunk, kinds: frozenset[str] | None, refs: Mapping[str, str] | None) -> bool:
    if kinds and chunk.kind not in kinds:
        return False
    return all(chunk.refs.get(key) == value for key, value in (refs or {}).items())


def search(
    items: Sequence[Indexed],
    query: str,
    query_vector: Sequence[float] | None = None,
    *,
    k: int = 5,
    kinds: frozenset[str] | None = None,
    refs: Mapping[str, str] | None = None,
) -> SearchResult:
    """The ``k`` best chunks for ``query`` among those passing the filters."""
    pool = [item for item in items if matches(item.chunk, kinds, refs)]
    keyword = BM25([chunk_tokens(item.chunk) for item in pool]).scores(tokenize(query))
    keyword_order = sorted(
        (i for i, score in enumerate(keyword) if score > 0), key=lambda i: (-keyword[i], i)
    )[:RANK_DEPTH]
    vector_order: list[int] = []
    mode: SearchMode = "keyword"
    if query_vector is not None:
        comparable = [
            (i, cosine(query_vector, item.vector))
            for i, item in enumerate(pool)
            if item.vector is not None and len(item.vector) == len(query_vector)
        ]
        if comparable:
            mode = "hybrid"
            vector_order = [i for i, _ in sorted(comparable, key=lambda p: (-p[1], p[0]))]
            vector_order = vector_order[:RANK_DEPTH]
    fused: dict[int, float] = {}
    keyword_rank = {index: rank for rank, index in enumerate(keyword_order, start=1)}
    vector_rank = {index: rank for rank, index in enumerate(vector_order, start=1)}
    for ranking in (keyword_rank, vector_rank):
        for index, rank in ranking.items():
            fused[index] = fused.get(index, 0.0) + 1.0 / (RRF_K + rank)
    best = sorted(fused, key=lambda i: (-fused[i], i))[:k]
    hits = [
        Hit(pool[i].chunk, round(fused[i], 6), keyword_rank.get(i), vector_rank.get(i))
        for i in best
    ]
    return SearchResult(hits, mode)
