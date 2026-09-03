"""Resolve canonical RAG source code separately from runtime data."""

from __future__ import annotations

import os
from pathlib import Path


APP_RAG_DIR = Path(__file__).resolve().parent
_PARENT_DIRS = tuple(APP_RAG_DIR.parents)
if len(_PARENT_DIRS) > 1:
    # Repository checkout: apps/rag -> repository root.
    REPO_ROOT = _PARENT_DIRS[1]
    DEFAULT_DATA_ROOT = REPO_ROOT / "data" / "rag"
else:
    # Container image: the canonical source is copied to /app and runtime
    # volumes are mounted below /srv/rag.
    REPO_ROOT = APP_RAG_DIR
    DEFAULT_DATA_ROOT = Path("/srv/rag")


def _configured_path(name: str) -> Path | None:
    raw_value = os.getenv(name, "").strip()
    if not raw_value:
        return None
    return Path(raw_value).expanduser().resolve()


def resolve_data_root() -> Path:
    """Return the root for relative inputs, artifacts, and local state."""
    return _configured_path("RAG_DATA_ROOT") or DEFAULT_DATA_ROOT


SOURCE_ROOT = APP_RAG_DIR
DATA_ROOT = resolve_data_root()


def resolve_data_path(raw_value: str | None, default: str) -> Path:
    """Resolve a configured data path without changing absolute paths."""
    value = (raw_value or default).strip()
    path = Path(value).expanduser()
    return path.resolve() if path.is_absolute() else (DATA_ROOT / path).resolve()


def source_metadata() -> dict[str, str]:
    """Return non-secret provenance suitable for logs and diagnostics."""
    return {
        "source_root": str(SOURCE_ROOT),
        "data_root": str(DATA_ROOT),
        "source_mode": "canonical",
    }
