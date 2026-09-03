import type {
  RagDocumentListResponse,
  RagPipelineStatus,
  RagReadinessReport,
  RagRetrievalResponse,
  ProcessingProfile,
  RagImportResponse,
  RagTask,
  RagTaskStatusResponse,
} from "../domains/rag";
import { api } from "./http";

export function checkRagReady(baseUrl: string): Promise<Record<string, unknown>> {
  return api<Record<string, unknown>>(baseUrl, "/api/v1/rag/ready");
}

export async function getRagReadiness(baseUrl: string): Promise<{ ok: boolean; report: RagReadinessReport }> {
  const response = await fetch(`${baseUrl}/api/v1/rag/ready`, { headers: { Accept: "application/json" } });
  const report = await response.json().catch(() => ({})) as RagReadinessReport;
  return { ok: response.ok, report };
}

export function listRagDocuments(baseUrl: string, page = 1, pageSize = 50): Promise<RagDocumentListResponse> {
  return api<RagDocumentListResponse>(baseUrl, `/api/v1/rag/documents?page=${page}&page_size=${pageSize}`);
}

export function getRagPipelineStatus(baseUrl: string): Promise<RagPipelineStatus> {
  return api<RagPipelineStatus>(baseUrl, "/api/v1/rag/pipeline");
}

export function retrieveRag(baseUrl: string, query: string): Promise<RagRetrievalResponse> {
  return api<RagRetrievalResponse>(baseUrl, "/api/v1/rag/retrievals", {
    method: "POST",
    body: JSON.stringify({ query, mode: "mix", top_k: 10, chunk_top_k: 10, max_total_tokens: 8000, enable_rerank: true }),
  });
}

export function deleteRagDocuments(baseUrl: string, documentIds: string[]): Promise<{ tasks: Array<Record<string, unknown>> }> {
  return api<{ tasks: Array<Record<string, unknown>> }>(baseUrl, "/api/v1/rag/documents:delete", {
    method: "POST",
    headers: { "X-Desktop-Confirmed": "true" },
    body: JSON.stringify({ document_ids: documentIds, delete_files: false, delete_llm_cache: false }),
  });
}

export function cancelRagTaskRequest(baseUrl: string, taskId: string): Promise<Record<string, unknown>> {
  return api<Record<string, unknown>>(baseUrl, `/api/v1/rag/tasks/${taskId}:cancel`, {
    method: "POST",
    headers: { "X-Desktop-Confirmed": "true" },
  });
}

export function getRagTask(
  baseUrl: string,
  taskId: string,
): Promise<RagTaskStatusResponse> {
  return api<RagTaskStatusResponse>(baseUrl, `/api/v1/rag/tasks/${taskId}`);
}

export function importRagDocumentRequest(
  baseUrl: string,
  filePath: string,
  processingProfile: ProcessingProfile,
): Promise<RagImportResponse> {
  return api<RagImportResponse>(baseUrl, "/api/v1/rag/imports", {
    method: "POST",
    body: JSON.stringify({ file_path: filePath, processing_profile: processingProfile }),
  });
}

export function retryRagTaskRequest(
  baseUrl: string,
  taskId: string,
): Promise<RagTask> {
  return api<RagTask>(baseUrl, `/api/v1/rag/tasks/${taskId}:retry`, {
    method: "POST",
  });
}
