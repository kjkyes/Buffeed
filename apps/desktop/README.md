# Desktop

`apps/desktop` 现在包含 Electron 配置、lockfile、main/preload、renderer 组件、业务 hook 和 Team 观测画布，是唯一新增功能应进入的桌面来源。主进程开发态和打包态均加载 `apps/agent-runtime`，打包资源只携带 canonical runtime；RAG ingest 数据目录仍不随源码迁移。

从本目录安装依赖后可运行 `npm run dev`、`npm run build` 或 `npm run preview`；根目录启动：`powershell -ExecutionPolicy Bypass -File apps/desktop/run.ps1`，脚本会在本目录执行 npm。当前回合可使用 Team；回合边界会挂起旧成员，Team 面板只读消费 `/team` 事件。
