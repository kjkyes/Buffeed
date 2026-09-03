# Agent runtime

`GET /health` 会返回当前 Team 工具能力和实际工具名；`/team` 和 `/team/events` 仍提供真实 durable 事件的只读观测。健康检查中的成员状态是历史/当前 journal 投影，不代表旧回合会继续运行。

依赖由本目录的 `pyproject.toml` 与 `uv.lock` 独立维护。从仓库根目录安装或更新环境：

```powershell
uv sync --project apps/agent-runtime
uv run --project apps/agent-runtime python apps/agent-runtime/run.py
```

该环境只服务 Agent runtime；RAG 依赖在 `apps/rag` 单独维护，跨 app 测试依赖不会自动进入本环境。
