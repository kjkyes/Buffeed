import type {
  CreateSessionResponse,
  CreateTurnResponse,
  Session,
  SessionListResponse,
  PersistedStreamEvent,
} from "../domains/agent";
import type { TeamObservation, TeamObservationEvent } from "../domains/team";
import { api } from "./http";

export type SessionDetails = Session & {
  active_turn_id: string | null;
  runtime_status?: "ready" | "restoring" | "cold" | "error";
  disabled_tools: string[];
};

export type CancelTurnResponse = {
  turn_id: string;
  status: string;
};

export type ForkSessionResponse = Session & {
  disabled_tools: string[];
  forked_from: string;
  forked_turn_id: string;
};

export type TurnStatusResponse = {
  turn_id: string;
  session_id: string;
  query: string;
  status: string;
  created_at: number;
  finished_at: number | null;
};

export type ApprovalResolutionResponse = {
  approval_id: string;
  approved: boolean;
};

export type McpConnectResponse = {
  server: string;
  result: string;
};

export type PluginInventoryItem = {
  id?: string;
  name: string;
  transport?: string;
  endpoint?: string;
  status?: string;
  source?: string;
  description?: string;
  origin?: string;
  path?: string;
  removable?: boolean;
};
export type PluginInventory = { mcp: PluginInventoryItem[]; skills: PluginInventoryItem[] };

export type GitHubPluginResult = {
  items: Array<{ full_name: string; description: string; html_url: string; default_branch: string; stars: number }>;
};

export type PluginInstallRequest = {
  workspace: string;
  kind: "mcp" | "skills";
  source: string;
  ref?: string;
  name?: string;
  transport?: "stdio" | "sse" | "streamable-http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
};

export type PluginInstallResponse = { kind: string; installed: string[]; source: string; message: string };

export type PluginUninstallRequest = {
  workspace: string;
  kind: "mcp" | "skills";
  name: string;
};

export type PluginUninstallResponse = { kind: string; removed: string[]; message: string };

export function getPluginInventory(baseUrl: string, workspace: string): Promise<PluginInventory> {
  return api<PluginInventory>(baseUrl, `/api/v1/plugins?workspace=${encodeURIComponent(workspace)}`);
}

export function searchGitHubPlugins(baseUrl: string, query: string, kind: "mcp" | "skills"): Promise<GitHubPluginResult> {
  return api<GitHubPluginResult>(baseUrl, `/api/v1/plugins/github/search?q=${encodeURIComponent(query)}&kind=${kind}`);
}

export function installPlugin(baseUrl: string, request: PluginInstallRequest): Promise<PluginInstallResponse> {
  return api<PluginInstallResponse>(baseUrl, "/api/v1/plugins/install", {
    method: "POST",
    body: JSON.stringify(request),
  });
}

export function uninstallPlugin(baseUrl: string, request: PluginUninstallRequest): Promise<PluginUninstallResponse> {
  return api<PluginUninstallResponse>(baseUrl, "/api/v1/plugins/uninstall", {
    method: "POST",
    body: JSON.stringify(request),
  });
}

export type TurnDelivery = "queue" | "steer";
export type TurnModel = string;
export type TurnModelOption = {
  id: TurnModel;
  label: string;
  provider: string;
  supports_video: boolean;
};
export type ModelsResponse = { models: TurnModelOption[] };
export type TurnAttachment = {
  path?: string;
  name: string;
  mime_type?: string;
  preview_url?: string;
  kind: "file" | "folder" | "image" | "video" | "audio" | "history";
  context?: string;
};

export type ImportedHistory = { text: string; eventCount: number };

export async function importSessionHistory(
  baseUrl: string,
  sessionId: string,
): Promise<ImportedHistory> {
  const response = await api<{ events?: Array<{ event_type?: string; payload?: Record<string, unknown> }> }>(
    baseUrl,
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/events?stream=false&summary=true&full_history=true&limit=200`,
  );
  const lines: string[] = [];
  for (const event of response.events ?? []) {
    const payload = event.payload ?? {};
    if (event.event_type === "turn.started" && typeof payload.query === "string") lines.push(`用户：${payload.query}`);
    if (event.event_type === "assistant.message" && payload.phase !== "streaming" && typeof payload.text === "string") lines.push(`Agent：${payload.text}`);
  }
  const text = lines.join("\n\n").slice(-30_000);
  return { text, eventCount: lines.length };
}

export type ChangeHunk = {
  startLine: number;
  endLine: number;
};

export type ChangeLine = {
  kind: "context" | "addition" | "deletion";
  oldLine?: number;
  newLine?: number;
  text: string;
};

export type ChangeFile = {
  path: string;
  additions: number;
  deletions: number;
  hunks: ChangeHunk[];
  diffLines?: ChangeLine[];
  status: "modified" | "deleted" | "untracked" | string;
};

export type ChangeSnapshot = {
  available: boolean;
  files: ChangeFile[];
  total_files: number;
  total_additions: number;
  total_deletions: number;
  created_files?: number;
  deleted_files?: number;
  modified_files?: number;
  protected_paths?: string[];
  revertible_files?: number;
};

export type RevertChangesResponse = {
  status: string;
  reverted_paths: string[];
  removed_paths: string[];
  protected_paths: string[];
  changes: ChangeSnapshot;
};

export type ReviewChangesResponse = {
  status: string;
  review_id: string;
  changes: ChangeSnapshot;
  protected_paths: string[];
};

export function checkAgentHealth(baseUrl: string): Promise<Record<string, unknown>> {
  return api<Record<string, unknown>>(baseUrl, "/health");
}

export function listSessions(baseUrl: string): Promise<SessionListResponse> {
  return api<SessionListResponse>(baseUrl, "/api/v1/sessions");
}

export function listModels(baseUrl: string): Promise<ModelsResponse> {
  return api<ModelsResponse>(baseUrl, "/api/v1/models");
}

export function getSession(baseUrl: string, sessionId: string): Promise<SessionDetails> {
  return api<SessionDetails>(baseUrl, `/api/v1/sessions/${sessionId}`);
}

export function createSessionRequest(
  baseUrl: string,
  workspace: string,
): Promise<CreateSessionResponse> {
  return api<CreateSessionResponse>(baseUrl, "/api/v1/sessions", {
    method: "POST",
    body: JSON.stringify({ workspace }),
  });
}

export function forkSessionRequest(
  baseUrl: string,
  sessionId: string,
  turnId: string,
): Promise<ForkSessionResponse> {
  return api<ForkSessionResponse>(baseUrl, `/api/v1/sessions/${sessionId}/fork`, {
    method: "POST",
    body: JSON.stringify({ turn_id: turnId }),
  });
}

export function createTurnRequest(
  baseUrl: string,
  sessionId: string,
  query: string,
  delivery: TurnDelivery = "queue",
  requestId?: string,
  signal?: AbortSignal,
  attachments: TurnAttachment[] = [],
  model: TurnModel = "system",
): Promise<CreateTurnResponse> {
  return api<CreateTurnResponse>(baseUrl, `/api/v1/sessions/${sessionId}/turns`, {
    method: "POST",
    body: JSON.stringify({ query, delivery, request_id: requestId, attachments, model }),
    signal,
  });
}

export function getTurnStatusRequest(
  baseUrl: string,
  sessionId: string,
  turnId: string,
  signal?: AbortSignal,
): Promise<TurnStatusResponse> {
  return api<TurnStatusResponse>(
    baseUrl,
    `/api/v1/sessions/${sessionId}/turns/${encodeURIComponent(turnId)}`,
    { signal },
  );
}

export function cancelTurnRequest(
  baseUrl: string,
  sessionId: string,
  turnId: string,
): Promise<CancelTurnResponse> {
  return api<CancelTurnResponse>(baseUrl, `/api/v1/sessions/${sessionId}/turns/${turnId}:cancel`, {
    method: "POST",
  });
}

export function getSessionChanges(
  baseUrl: string,
  sessionId: string,
): Promise<ChangeSnapshot> {
  return api<ChangeSnapshot>(baseUrl, `/api/v1/sessions/${sessionId}/changes`);
}

export function revertSessionChanges(
  baseUrl: string,
  sessionId: string,
): Promise<RevertChangesResponse> {
  return api<RevertChangesResponse>(baseUrl, `/api/v1/sessions/${sessionId}/changes:revert`, {
    method: "POST",
  });
}

export function reviewSessionChanges(
  baseUrl: string,
  sessionId: string,
): Promise<ReviewChangesResponse> {
  return api<ReviewChangesResponse>(baseUrl, `/api/v1/sessions/${sessionId}/changes:review`, {
    method: "POST",
  });
}

export function resolveApprovalRequest(
  baseUrl: string,
  approvalId: string,
  approved: boolean,
): Promise<ApprovalResolutionResponse> {
  return api<ApprovalResolutionResponse>(baseUrl, `/api/v1/approvals/${approvalId}`, {
    method: "POST",
    body: JSON.stringify({ approved }),
  });
}

export function connectMcpServer(
  baseUrl: string,
  sessionId: string,
  serverName: string,
): Promise<McpConnectResponse> {
  return api<McpConnectResponse>(baseUrl, `/api/v1/sessions/${sessionId}/mcp/${serverName}:connect`, {
    method: "POST",
  });
}

export function getTeamObservation(
  baseUrl: string,
  sessionId: string,
): Promise<TeamObservation> {
  return api<TeamObservation>(baseUrl, `/api/v1/sessions/${sessionId}/team`);
}

export type TeamObservationEventsResponse = {
  execution_id: string;
  events: TeamObservationEvent[];
  snapshot: TeamObservation;
};

export function getTeamObservationEvents(
  baseUrl: string,
  sessionId: string,
  after: number,
  executionId?: string | null,
): Promise<TeamObservationEventsResponse> {
  const cursor = Math.max(0, Math.floor(after));
  const selectedExecution = executionId?.trim();
  const query = new URLSearchParams({ after: String(cursor) });
  if (selectedExecution) {
    query.set("execution_id", selectedExecution);
  }
  return api<TeamObservationEventsResponse>(
    baseUrl,
    `/api/v1/sessions/${sessionId}/team/events?${query.toString()}`,
    { headers: { "Last-Event-ID": String(cursor) } },
  );
}

export function getEventDetail(
  baseUrl: string,
  sessionId: string,
  eventId: string,
): Promise<PersistedStreamEvent> {
  return api<PersistedStreamEvent>(
    baseUrl,
    `/api/v1/sessions/${sessionId}/events/${encodeURIComponent(eventId)}`,
  );
}
