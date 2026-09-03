export const AGENT_STREAM_EVENT_TYPES = [
  "session.created",
  "turn.queued",
  "turn.started",
  "user_interjection",
  "model.requested",
  "assistant.message",
  "tool.requested",
  "tool.result",
  "approval.requested",
  "approval.resolved",
  "turn.cancelled",
  "turn.completed",
  "turn.finished",
  "turn.error",
  "turn.cancel.requested",
  "video.progress",
  "video.failed",
  "run.plan",
  "run.started",
  "run.progress",
  "run.completed",
  "run.failed",
] as const;

export type KnownAgentStreamEventType = (typeof AGENT_STREAM_EVENT_TYPES)[number];
// The journal remains forward-compatible with event types added by the runtime.
export type AgentStreamEventType = string;
export type EventPayload = Record<string, unknown>;

export type Session = {
  session_id: string;
  workspace: string;
  status: string;
  created_at: number;
  updated_at: number;
  title: string;
  /** Hot sessions are prewarmed and may request the complete folded history. */
  history_mode?: "full" | "window";
};

export type StreamEvent = {
  event_id: string;
  type: string;
  turnId: string | null;
  payload: EventPayload;
  createdAt: number | null;
};

/** JSON body carried by one SSE frame; id and event type live in SSE headers. */
export type SseEventData = {
  turn_id: string | null;
  payload: EventPayload;
  created_at?: number;
};

export type SseEventEnvelope = {
  id: string;
  event: string;
  data: SseEventData;
};

export type PersistedStreamEvent = {
  event_id: number;
  event_type: string;
  turn_id: string | null;
  payload: EventPayload;
  created_at: number;
};

export type ChatAttachment = {
  name: string;
  path?: string;
  kind: "file" | "folder" | "image" | "video" | "audio" | "history";
  mimeType?: string;
  previewUrl?: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  turnId: string | null;
  attachments?: ChatAttachment[];
};

export type Approval = {
  id: string;
  toolName: string;
  input: EventPayload;
  turnId?: string | null;
};

export type SessionListResponse = {
  sessions: Session[];
};

export type CreateSessionResponse = {
  session_id: string;
  workspace: string;
  disabled_tools: string[];
};

export type CreateTurnResponse = {
  turn_id: string;
  status: string;
  title?: string;
  interjection_id?: string;
  queue_turn_id?: string;
  degraded_from?: string;
};
