import type {
  PageRoute,
  PageRoutingManifest,
  ProcessingProfile,
  RagImportResponse,
  RagTask,
  RagTaskEvent,
  RagTaskStatus,
  RagTaskStatusResponse,
} from "@agentcore/contracts";

export const DEFAULT_RAG_API = "http://127.0.0.1:8001";

export type {
  PageRoute,
  PageRoutingManifest,
  ProcessingProfile,
  RagImportResponse,
  RagTask,
  RagTaskEvent,
  RagTaskStatus,
  RagTaskStatusResponse,
} from "@agentcore/contracts";

export type RagDocument = {
  id?: string;
  document_id?: string;
  file_path?: string;
  file_name?: string;
  status?: string;
  created_at?: string | number;
  updated_at?: string | number;
  chunks_count?: number;
  error_msg?: string;
  error_detail?: string;
  [key: string]: unknown;
};

export type RagDocumentListResponse = {
  documents?: RagDocument[];
  total_count?: number;
  total?: number;
  page?: number;
  page_size?: number;
  [key: string]: unknown;
};

export type RagReadinessReport = {
  status?: string;
  process_ready?: boolean;
  active_profile?: string;
  lightrag_ready?: boolean;
  postgres_ready?: boolean;
  docling_ready?: boolean;
  services?: Record<string, { reachable?: boolean; status?: string; detail?: string; [key: string]: unknown }>;
  [key: string]: unknown;
};

export type RagPipelineStatus = Record<string, unknown>;
export type RagRetrievalResponse = Record<string, unknown>;

export const RAG_PROFILES: Array<{
  value: ProcessingProfile;
  label: string;
  description: string;
  requiresVlm: boolean;
}> = [
  { value: "text", label: "文本", description: "原生文本优先；扫描 PDF 页面自动改用整页 VLM", requiresVlm: false },
  { value: "visual", label: "视觉", description: "图片与公式优先；扫描的 PDF/Office 页面使用整页 VLM", requiresVlm: true },
  { value: "table", label: "表格", description: "表格优先；扫描的 PDF/Office 页面使用整页 VLM", requiresVlm: true },
  { value: "full", label: "完整", description: "所有 PDF/Office 页面使用整页 VLM；质量优先，耗时更长", requiresVlm: true },
];

export const RAG_TASK_TERMINAL_STATUSES = new Set<RagTaskStatus>([
  "vector_ready",
  "graph_ready",
  "failed",
  "cancelled",
]);

export function pageRouteStatusLabel(route: PageRoute): string {
  const labels: Record<PageRoute["status"], string> = {
    ready: "原生文本",
    pending: "等待 VLM",
    processing: "整页 VLM 中",
    cached: "VLM 缓存",
    completed: "VLM 完成",
    failed: "VLM 失败",
  };
  return labels[route.status];
}
