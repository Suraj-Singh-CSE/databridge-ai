"""Where the project documentation indexed as ``docs`` chunks comes from (ADR 0024).

The root holds ``README.md`` and ``docs/adr/*.md``. By default it is the repository the code
runs from (local runs, tests, the eval). The Docker image does not contain the repository, so
the Dockerfile copies those files to ``/app/knowledge-docs`` with the same layout and sets
``KNOWLEDGE_DOCS_DIR`` to it. A missing root simply yields no docs chunks.
"""

from pathlib import Path

from app.knowledge.chunks import DocFile

# apps/ai-service/app/knowledge/docs.py -> the repository root.
SOURCE_ROOT = Path(__file__).resolve().parents[4]


def docs_root(configured: str) -> Path:
    return Path(configured) if configured else SOURCE_ROOT


def load_docs(root: Path) -> list[DocFile]:
    files = [root / "README.md", *sorted((root / "docs" / "adr").glob("*.md"))]
    return [
        DocFile(path.relative_to(root).as_posix(), path.read_text(encoding="utf-8"))
        for path in files
        if path.is_file()
    ]
