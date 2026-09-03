"""Shared paths for user-level Buffeed state."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path


RUNTIME_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = RUNTIME_DIR.parents[1]
DEFAULT_HOME = PROJECT_ROOT.parent / ".buffeed"


def buffeed_home() -> Path:
    """Return the shared user state root, honoring an explicit override."""
    configured = os.getenv("BUFFEED_HOME", "").strip()
    return (Path(configured).expanduser() if configured else DEFAULT_HOME).resolve()


def load_buffeed_env() -> Path | None:
    """Load the user-level environment file without changing workspace config."""
    env_path = buffeed_home() / ".env"
    if not env_path.is_file():
        return None
    from dotenv import load_dotenv

    load_dotenv(env_path, override=True)
    return env_path


def workspace_state_dir(workspace: Path) -> Path:
    """Return a stable per-workspace state directory below the shared root."""
    resolved = workspace.expanduser().resolve()
    digest = hashlib.sha256(str(resolved).encode("utf-8", "surrogatepass")).hexdigest()[:16]
    return buffeed_home() / "workspaces" / digest
