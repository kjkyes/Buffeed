# Deployment

`deploy/compose.ps1` 是统一部署入口，但不会复制 Compose 文件。`data/rag/compose.yaml` 仍是唯一的 Compose 编排事实来源；它的 build context、Python 模块和迁移 SQL 均来自 `apps/rag`。输入、密钥、数据库和 named volumes 继续由 `data/rag` 承载，这是数据根保留，不是 RAG 源码目录。

```powershell
# 静态检查（无参数时的默认行为）
powershell -ExecutionPolicy Bypass -File deploy/compose.ps1

# 启动完整 RAG 栈
powershell -ExecutionPolicy Bypass -File deploy/compose.ps1 up -d docling-serve lightrag gateway rag-worker
```

部署目录只负责统一入口和环境说明，不把 Docker、数据库或模型服务嵌进 Electron 安装包。
