import { useState } from "react";
import { Database, X } from "lucide-react";
import { RagWorkspace } from "./RagWorkspace";
import { useRagWorkspace } from "../hooks/useRagWorkspace";

export function RagManager() {
  const [statusMessage, setStatusMessage] = useState("");
  const rag = useRagWorkspace({ setStatusMessage });
  return <main className="rag-manager-window">
    <header className="rag-manager-header"><div><span className="eyebrow">独立服务管理</span><h1><Database size={18} /> RAG 知识库</h1></div><button className="icon-button" type="button" title="关闭窗口" aria-label="关闭窗口" onClick={() => window.close()}><X size={17} /></button></header>
    <div className="rag-manager-body"><RagWorkspace
      ragTask={rag.ragTask}
      ragHealthy={rag.ragHealthy}
      readiness={rag.readiness}
      documents={rag.documents}
      documentsTotal={rag.documentsTotal}
      documentsLoading={rag.documentsLoading}
      pipelineStatus={rag.pipelineStatus}
      retrievalResult={rag.retrievalResult}
      retrievalLoading={rag.retrievalLoading}
      processingProfile={rag.processingProfile}
      selectedProfile={rag.selectedProfile}
      onProcessingProfileChange={rag.setProcessingProfile}
      onImportRagDocument={rag.importRagDocument}
      onRetryRagTask={rag.retryRagTask}
      onRefresh={async () => { await Promise.all([rag.refreshRagHealth(), rag.refreshDocuments(), rag.refreshPipeline()]); }}
      onDeleteDocuments={rag.removeDocuments}
      onCancelTask={rag.cancelTask}
      onRunRetrieval={rag.runRetrieval}
    /></div>
    {statusMessage && <p className="rag-manager-status" role="status">{statusMessage}</p>}
  </main>;
}
