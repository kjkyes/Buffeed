"""Start LightRAG after loading the selected application profile."""

from __future__ import annotations

import rag_config  # noqa: F401 - profile must be loaded before LightRAG imports
from lightrag.api.lightrag_server import main


if __name__ == "__main__":
    main()
