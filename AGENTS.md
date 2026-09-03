# 项目协作规则

本文件只描述 `Buffeed` 的项目边界；上层工具和用户指令优先。

## 目录边界

- `apps/agent-runtime` 是 Agent API、Buffeed 核心、Team journal/投影、bundled skills 和 MCP 默认配置的唯一事实来源。
- `apps/desktop` 是 Electron 生命周期、窗口和 React UI 的唯一事实来源。
- `apps/rag` 是 RAG REST facade、MCP Gateway、LightRAG 编排、worker 和迁移脚本的唯一事实来源。
- `data/rag` 只承载 Compose 编排、环境配置和输入、密钥、存储等运行数据，不承载 RAG 源码。
- `howtocook-mcp` 是可选示例，不作为核心运行时依赖。

## 变更规则

1. 跨模块改动先更新 `docs/索引.md` 中的归属和状态。
2. 不让 renderer 直接调用 MCP、数据库或 LightRAG 内部接口。
3. 保留 `Buffeed -> MCP Gateway -> LightRAG` 路由；RAG UI 操作走 REST facade。
4. Team 画布只能由真实事件投影，不根据普通工具调用猜测成员或任务。
5. 新功能只能进入 canonical `apps/*`；已完成迁移的旧路径不再新增兼容 shim，若确有外部兼容需求必须单独记录期限和影响。
6. `inputs`、`secrets`、RAG storage、SQLite 状态库和构建产物不纳入源码迁移。

## 状态标记

文档和模块 README 使用 `landed`、`reference`、`blueprint`。`blueprint` 内容必须明确写出依赖的运行时前提和未完成项。

## 验证门槛

- Python 改动：先运行 `python -m compileall` 目标目录，再运行已有 pytest。
- Electron 改动：运行 `npm run build`，涉及交互时再做桌面手工验证。
- RAG 配置改动：运行 `docker compose config --quiet`；不把离线配置检查写成服务已启动。
- 事件协议改动：同时更新 `docs/03-运行时/事件契约.md` 和前端消费方。
