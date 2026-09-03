export type ProcessingProfile = "text" | "visual" | "table" | "full";

export type RagTaskType = "ingest" | "rebuild" | "graph" | "delete";
export type RagTaskStatus =
  | "queued"
  | "vector_ready"
  | "kg_pending"
  | "kg_running"
  | "graph_ready"
  | "failed"
  | "cancelled";

export type RagTask = {
  task_id: string;
  document_id: string;
  revision: number;
  task_type: RagTaskType;
  status: RagTaskStatus;
  attempt: number;
  lightrag_track_id: string | null;
  error_detail: string | null;
  parent_task_id: string | null;
  cancel_requested: boolean;
  request_id: string | null;
};

export type RagTaskEvent = {
  event_id: number;
  from_status: RagTaskStatus | null;
  to_status: RagTaskStatus;
  detail: string | null;
  worker_id: string | null;
  request_id: string | null;
  occurred_at: string;
};

export type PageRoute = {
  page: number;
  route: "native_pdf_text" | "full_page_vlm";
  reason: string;
  canonical_source: "embedded_pdf_text" | "vlm_transcription";
  native_text_chars: number;
  control_character_ratio: number;
  status: "ready" | "pending" | "processing" | "cached" | "completed" | "failed";
  vlm_cache_hit: boolean | null;
  error: string | null;
};

export type PageRoutingManifest = {
  processing_profile: ProcessingProfile;
  page_count: number;
  pages: PageRoute[];
  schema_version?: number;
  prompt_version?: string;
  source_file?: string;
  source_kind?: string;
  rendered_file?: string | null;
  conversion?: Record<string, unknown> | null;
  fallback_pages?: number[];
};

export type RagTaskStatusResponse = {
  task: RagTask;
  events: RagTaskEvent[];
  children: RagTask[];
  page_routing: PageRoutingManifest | null;
};

export type RagImportDisposition = "created" | "idempotent" | "requeued" | string;

export type RagImportResponse = {
  disposition: RagImportDisposition;
  document_id: string;
  revision: number;
  task_id: string | null;
};
