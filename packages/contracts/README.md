# Shared contracts

这里仅放跨端传输形状：Agent 持久化事件与 SSE data、RAG durable task DTO、Team journal observation/event DTO。运行时校验和状态折叠仍分别由 `apps/agent-runtime/team_events.py`、RAG gateway/worker 以及 renderer 的 domain 适配层负责；本包不放 UI 文案、业务 fold 或服务实现。

## 消费方式

Electron renderer 通过 `@agentcore/contracts` 别名导入本包。`domains/agent.ts`、`domains/rag.ts`、`domains/team.ts` 保留兼容导出，并只承载本地展示和投影逻辑。

## 事实来源

- Agent wire 字段：`apps/agent-runtime/desktop_api.py` 的 SQLite journal 与 `_format_sse`。
- Team 事件校验/fold：`apps/agent-runtime/team_events.py`；只读快照版本为 2。
- RAG task DTO：`apps/rag/rag_jobs.py`、`apps/rag/gateway.py`；`data/rag` 仅承载 Compose 与运行数据，canonical REST facade 为 `apps/rag/rag_api.py`。

未知 Agent 事件必须保留为普通 `string`，已知事件数组只用于 SSE 监听；新增后端事件不应因客户端未升级而被丢弃。字段新增优先保持可选，除非运行时校验已将其设为必填。
