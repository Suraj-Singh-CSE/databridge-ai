"""Column mapping: suggest which target field each source column fills (ADR 0012).

The scoring, resolution and prompt code is pure (no MongoDB, Redis or network), so the evaluation
in ``eval/`` imports it directly.
"""
