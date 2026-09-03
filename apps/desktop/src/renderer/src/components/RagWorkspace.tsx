import { useMemo, useState } from "react";
import { Activity, AlertTriangle, Ban, CheckCircle2, FilePlus2, RefreshCw, RotateCcw, Search, Trash2 } from "lucide-react";

import { pageRouteStatusLabel, RAG_PROFILES, type ProcessingProfile, type RagDocument, type RagPipelineStatus, type RagReadinessReport, type RagRetrievalResponse, type RagTaskStatusResponse } from "../domains/rag";

type RagWorkspaceProps = {
  ragTask: RagTaskStatusResponse | null;
  ragHealthy: boolean | null;
  readiness: RagReadinessReport | null;
  documents: RagDocument[];
  documentsTotal: number;
  documentsLoading: boolean;
  pipelineStatus: RagPipelineStatus | null;
  retrievalResult: RagRetrievalResponse | null;
  retrievalLoading: boolean;
  processingProfile: ProcessingProfile;
  selectedProfile: (typeof RAG_PROFILES)[number];
  onProcessingProfileChange: (profile: ProcessingProfile) => void;
  onImportRagDocument: () => void | Promise<void>;
  onRetryRagTask: () => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
  onDeleteDocuments: (documentIds: string[]) => void | Promise<void>;
  onCancelTask: (taskId: string) => void | Promise<void>;
  onRunRetrieval: (query: string) => void | Promise<void>;
};

function valueOf(document: RagDocument, ...keys: string[]): string {
  for (const key of keys) {
    const value = document[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number") return String(value);
  }
  return "-";
}

function formatDate(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function prettyJson(value: unknown): string {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

export function RagWorkspace({ ragTask, ragHealthy, readiness, documents, documentsTotal, documentsLoading, pipelineStatus, retrievalResult, retrievalLoading, processingProfile, selectedProfile, onProcessingProfileChange, onImportRagDocument, onRetryRagTask, onRefresh, onDeleteDocuments, onCancelTask, onRunRetrieval }: RagWorkspaceProps) {
  const [selectedDocuments, setSelectedDocuments] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const selectedIds = useMemo(() => new Set(selectedDocuments), [selectedDocuments]);
  const getId = (document: RagDocument) => valueOf(document, "document_id", "id");
  const toggleDocument = (id: string) => setSelectedDocuments((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const toggleAll = () => {
    const ids = documents.map(getId).filter((id) => id !== "-");
    setSelectedDocuments(selectedIds.size === ids.length ? [] : ids);
  };
  const deleteSelected = () => {
    if (selectedDocuments.length === 0) return;
    if (window.confirm(`确认删除 ${selectedDocuments.length} 个知识库文档？删除会提交后台任务。`)) {
      void onDeleteDocuments(selectedDocuments);
      setSelectedDocuments([]);
    }
  };

  return <div className="rag-workspace">
    <section className="rag-section rag-overview-section">
      <div className="rag-section-heading"><Activity size={16} /> 服务状态 <button className="icon-button" type="button" title="刷新 RAG 状态" aria-label="刷新 RAG 状态" onClick={() => void onRefresh()}><RefreshCw size={14} /></button></div>
      <div className="rag-status-grid">
        <div className={`rag-status-card ${ragHealthy ? "ready" : "unavailable"}`}><span>{ragHealthy ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}</span><strong>{ragHealthy ? "已就绪" : "不可用"}</strong><small>Facade / LightRAG</small></div>
        <div className={`rag-status-card ${readiness?.docling_ready ? "ready" : "unavailable"}`}><span>{readiness?.docling_ready ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}</span><strong>{readiness?.docling_ready ? "已连接" : "未连接"}</strong><small>Docling</small></div>
        <div className={`rag-status-card ${readiness?.postgres_ready ? "ready" : "unavailable"}`}><span>{readiness?.postgres_ready ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}</span><strong>{readiness?.postgres_ready ? "已连接" : "未连接"}</strong><small>PostgreSQL</small></div>
        <div className="rag-status-card"><strong>{readiness?.active_profile ?? "local"}</strong><small>运行 profile</small></div>
      </div>
      {!ragHealthy && <p className="rag-inline-warning">RAG facade 或下游依赖未就绪。可先启动 data/rag Compose 服务，再刷新状态。</p>}
    </section>
    <section className="rag-section">
      <div className="rag-section-heading"><FilePlus2 size={16} /> 导入配置</div>
      <div className="profile-control"><label htmlFor="rag-processing-profile">处理 profile</label><select id="rag-processing-profile" className="profile-select" value={processingProfile} aria-describedby="rag-processing-profile-help" onChange={(event) => onProcessingProfileChange(event.target.value as ProcessingProfile)}>{RAG_PROFILES.map((profile) => <option key={profile.value} value={profile.value}>{profile.label}{profile.requiresVlm ? "（VLM）" : ""}</option>)}</select><p id="rag-processing-profile-help" className="profile-help">{selectedProfile.description}</p></div>
      <button className="secondary-button" onClick={() => void onImportRagDocument()} disabled={ragHealthy !== true}><FilePlus2 size={16} /> 导入文档</button>
    </section>
    <section className="rag-section rag-documents-section">
      <div className="rag-section-heading"><span><FilePlus2 size={16} /> 知识库文档 <small>{documentsTotal} 个</small></span><div className="rag-section-actions"><button className="icon-button" type="button" title="刷新文档列表" aria-label="刷新文档列表" onClick={() => void onRefresh()}><RefreshCw size={14} /></button><button className="icon-button danger" type="button" title="删除选中文档" aria-label="删除选中文档" disabled={selectedDocuments.length === 0} onClick={deleteSelected}><Trash2 size={14} /></button></div></div>
      <div className="rag-document-toolbar"><label><input type="checkbox" checked={documents.length > 0 && selectedIds.size === documents.length} onChange={toggleAll} /> 全选</label>{selectedDocuments.length > 0 && <span>已选 {selectedDocuments.length} 个</span>}</div>
      {documentsLoading ? <p className="rag-muted">正在加载文档列表...</p> : documents.length === 0 ? <p className="rag-muted">暂无已登记文档，导入后将在这里显示。</p> : <div className="rag-document-list">{documents.map((document, index) => { const id = getId(document); return <article className="rag-document-row" key={id === "-" ? index : id}><input type="checkbox" checked={selectedIds.has(id)} disabled={id === "-"} onChange={() => toggleDocument(id)} /><div className="rag-document-main"><strong title={valueOf(document, "source_uri", "source_key")}>{valueOf(document, "source_uri", "source_key")}</strong><small>{valueOf(document, "status")} · revision {valueOf(document, "revision")} · 更新于 {formatDate(document.updated_at ?? document.created_at)}</small>{valueOf(document, "error_detail", "error_msg") !== "-" && <p className="rag-document-error">{valueOf(document, "error_detail", "error_msg")}</p>}</div><span className="rag-document-count">{valueOf(document, "processing_profile")}</span></article>; })}</div>}
    </section>
    <section className="rag-section">
      <div className="rag-section-heading"><Search size={16} /> 检索测试</div>
      <form className="rag-query-form" onSubmit={(event) => { event.preventDefault(); void onRunRetrieval(query); }}><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入问题，测试知识库检索" /><button className="primary-button" type="submit" disabled={retrievalLoading || ragHealthy !== true}><Search size={15} /> {retrievalLoading ? "检索中" : "检索"}</button></form>
      {retrievalResult && <pre className="rag-json-output">{prettyJson(retrievalResult)}</pre>}
    </section>
    <section className="rag-section rag-operations-section">
      <div className="rag-section-heading"><Activity size={16} /> 任务与流水线</div>
      {ragTask && (
        <div className="rag-task-status" aria-live="polite">
          <div className="rag-task-heading">
            <strong>{ragTask.task.status}</strong>
            <small>任务 {ragTask.task.task_id.slice(0, 8)}</small>
            {["queued", "processing", "kg_pending"].includes(ragTask.task.status) && <button className="icon-button danger" type="button" title="取消 RAG 任务" aria-label="取消 RAG 任务" onClick={() => void onCancelTask(ragTask.task.task_id)}><Ban size={14} /></button>}
            {["failed", "cancelled"].includes(ragTask.task.status) && <button className="icon-button" type="button" title="重试 RAG 任务" aria-label="重试 RAG 任务" onClick={() => void onRetryRagTask()}><RotateCcw size={15} /></button>}
          </div>
          {ragTask.task.error_detail && <p className="task-error">{ragTask.task.error_detail}</p>}
          {ragTask.page_routing && (
            <div className="page-routing-list" aria-label="页级路由">
              {ragTask.page_routing.pages.map((route) => (
                <div className="page-route" key={route.page}>
                  <span>第 {route.page} 页</span>
                  <span className={`page-route-status ${route.status}`}>{pageRouteStatusLabel(route)}</span>
                  <small>{route.error ?? (route.canonical_source === "vlm_transcription" ? "VLM 结果" : "原生文本")}</small>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {pipelineStatus && <pre className="rag-pipeline-output">{prettyJson(pipelineStatus)}</pre>}
    </section>
  </div>;
}
