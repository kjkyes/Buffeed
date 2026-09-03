"""Canonical import boundary for the Buffeed runtime.

The implementation lives in :mod:`Buffeed_core` beside this adapter. A custom
source may be selected explicitly with ``BUFFEED_CORE_PATH`` for diagnostics, but
the runtime never silently falls back to another implementation.
"""

from __future__ import annotations

import importlib.util
import os
import runpy
import sys
from pathlib import Path


_MODULE_PATH = Path(__file__).resolve()
_CANONICAL_PATH = _MODULE_PATH.with_name("Buffeed_core.py")
_configured_core = os.getenv("BUFFEED_CORE_PATH", "").strip()
_configured_path = Path(_configured_core).expanduser().resolve() if _configured_core else None
if _configured_path is not None and not _configured_path.is_file():
    raise ImportError(f"Configured BUFFEED_CORE_PATH was not found: {_configured_path}")
if not _CANONICAL_PATH.is_file():
    raise ImportError(f"Canonical Buffeed source was not found: {_CANONICAL_PATH}")
CORE_PATH = _configured_path or _CANONICAL_PATH
SOURCE_MODE = "custom" if _configured_path is not None else "canonical"
_MODULE_NAME = f"Buffeed_core_{__name__.replace('.', '_')}"
_SPEC = importlib.util.spec_from_file_location(_MODULE_NAME, CORE_PATH)
if _SPEC is None or _SPEC.loader is None:
    raise ImportError(f"Unable to load Buffeed source: {CORE_PATH}")
_CORE = importlib.util.module_from_spec(_SPEC)
sys.modules[_MODULE_NAME] = _CORE
_SPEC.loader.exec_module(_CORE)

for _name, _value in _CORE.__dict__.items():
    if not _name.startswith("__"):
        globals()[_name] = _value


if __name__ == "__main__":
    runpy.run_path(str(CORE_PATH), run_name="__main__")
