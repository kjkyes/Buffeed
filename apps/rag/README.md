# RAG service

`apps/rag` 是 RAG REST/MCP facade、gateway、worker、配置适配器、registry、迁移脚本和依赖清单的唯一 canonical 运行源码。`source_layout.py` 明确区分源码根与运行数据根；默认源码来自本目录，默认数据根仍是 `data/rag`。Compose 使用本目录作为 build context，迁移 SQL 位于 `apps/rag/postgres-init`。可从仓库根目录运行 `uv run --project apps/rag python apps/rag/run.py` 启动 facade，或使用 `deploy/compose.ps1` 启动完整服务栈。

RAG/MCP 源码不再在 `data/rag` 保留副本或转发入口。MCP Gateway 由 `apps/rag/gateway.py` 提供，Agent 的 MCP 客户端由 `apps/agent-runtime/Buffeed_core.py` 提供。

`run.py` 在主机调试时默认保留旧 `data/rag` 作为相对数据路径的工作目录；生产/Compose 应显式设置 `RAG_ARTIFACT_ROOT`、`RAG_INGEST_ROOTS`、`RAG_LIGHTRAG_SIDECAR_ROOT` 和 `RAG_GRAPH_WORKING_DIR`，不要把 secrets、inputs、LightRAG storage 或 artifacts 复制进源码目录。

依赖由本目录的 `pyproject.toml` 与 `uv.lock` 独立维护。从仓库根目录安装或更新主机调试环境：

```powershell
uv sync --project apps/rag
uv run --project apps/rag python apps/rag/run.py
```

Compose 镜像沿用 `requirements.txt` 作为容器安装入口；它与 `pyproject.toml` 保持同一组固定运行版本。RAG 依赖不会安装进 Agent runtime 环境。

生产解析使用 Docling，Agent 访问路径为 `Buffeed -> MCP Gateway -> LightRAG`。
