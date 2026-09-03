"""Load shared RAG settings and an optional Spring-style active profile."""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Mapping

from dotenv import dotenv_values

from source_layout import APP_RAG_DIR, DATA_ROOT, resolve_data_path


_PROFILE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
_ROOT = APP_RAG_DIR
_CONFIG_DIR = _ROOT / "config"
_DATA_CONFIG_ROOT = DATA_ROOT
_loaded_profile: str | None = None


def _read_values(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    return {
        key: value
        for key, value in dotenv_values(path).items()
        if key and value is not None
    }


def _resolve_profile_file(raw_path: str | None, profile: str) -> Path:
    if raw_path and raw_path.strip():
        path = Path(raw_path.strip()).expanduser()
        if path.is_absolute():
            return path
        local_candidate = (_ROOT / path).resolve()
        if local_candidate.is_file():
            return local_candidate
        return resolve_data_path(raw_path, raw_path)
    candidates = (
        _CONFIG_DIR / f"application-{profile}.env",
        _DATA_CONFIG_ROOT / "config" / f"application-{profile}.env",
    )
    return next((candidate for candidate in candidates if candidate.is_file()), candidates[0])


def load_rag_config() -> str:
    """Load base, legacy, and active-profile values without overriding OS env."""
    global _loaded_profile
    if _loaded_profile is not None:
        return _loaded_profile

    preexisting_keys = set(os.environ)
    base_values = _read_values(_CONFIG_DIR / "application.env")
    if not base_values:
        base_values = _read_values(_DATA_CONFIG_ROOT / "config" / "application.env")
    legacy_values = _read_values(_ROOT / ".env")
    if not legacy_values:
        legacy_values = _read_values(_DATA_CONFIG_ROOT / ".env")
    requested_profile = (
        os.getenv("RAG_ACTIVE_PROFILE")
        or legacy_values.get("RAG_ACTIVE_PROFILE")
        or base_values.get("RAG_ACTIVE_PROFILE")
        or "local"
    ).strip()
    if not _PROFILE_NAME.fullmatch(requested_profile):
        raise ValueError(
            "RAG_ACTIVE_PROFILE must contain only letters, numbers, '-' or '_'"
        )

    profile_path_value = (
        os.getenv("RAG_PROFILE_ENV_FILE")
        or legacy_values.get("RAG_PROFILE_ENV_FILE")
        or base_values.get("RAG_PROFILE_ENV_FILE")
    )
    profile_values = _read_values(
        _resolve_profile_file(profile_path_value, requested_profile)
    )

    merged: dict[str, str] = {}
    merged.update(base_values)
    merged.update(legacy_values)
    merged.update(profile_values)
    for key, value in merged.items():
        if key == "RAG_ACTIVE_PROFILE":
            continue
        if key not in preexisting_keys:
            os.environ[key] = value
    if "RAG_ACTIVE_PROFILE" not in preexisting_keys:
        os.environ["RAG_ACTIVE_PROFILE"] = requested_profile
    _loaded_profile = requested_profile
    return requested_profile


ACTIVE_PROFILE = load_rag_config()


def loaded_sources() -> Mapping[str, str]:
    """Return non-secret metadata for diagnostics without exposing file contents."""
    return {
        "active_profile": ACTIVE_PROFILE,
        "config_dir": str(_CONFIG_DIR),
        "data_config_root": str(_DATA_CONFIG_ROOT),
        "source_root": str(APP_RAG_DIR),
        "data_root": str(DATA_ROOT),
    }

