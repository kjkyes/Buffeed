"""Run the canonical RAG REST/MCP facade through the unified root entry point."""

from __future__ import annotations

import os
import runpy
import sys
from pathlib import Path

APP_RAG_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(APP_RAG_DIR))
from source_layout import DATA_ROOT

SOURCE = APP_RAG_DIR / "rag_api.py"


def main() -> None:
    if not SOURCE.is_file():
        raise FileNotFoundError(f"RAG API source was not found: {SOURCE}")
    sys.path.insert(0, str(SOURCE.parent))
    runtime_cwd = Path(
        os.getenv("RAG_RUNTIME_CWD", str(DATA_ROOT))
    ).expanduser().resolve()
    previous_cwd = Path.cwd()
    os.chdir(runtime_cwd)
    try:
        runpy.run_path(str(SOURCE), run_name="__main__")
    finally:
        os.chdir(previous_cwd)


if __name__ == "__main__":
    main()
