"""Run the current Agent API through the unified root entry point."""

from __future__ import annotations

import os
import runpy
import sys
from pathlib import Path


RUNTIME_DIR = Path(__file__).resolve().parent
SOURCE = RUNTIME_DIR / "desktop_api.py"
REPO_ROOT = RUNTIME_DIR.parents[1]


def main() -> None:
    if not SOURCE.is_file():
        raise FileNotFoundError(f"Agent API source was not found: {SOURCE}")
    sys.path.insert(0, str(RUNTIME_DIR))
    sys.path.insert(0, str(SOURCE.parent))
    previous_cwd = Path.cwd()
    os.chdir(REPO_ROOT)
    try:
        runpy.run_path(str(SOURCE), run_name="__main__")
    finally:
        os.chdir(previous_cwd)


if __name__ == "__main__":
    main()
