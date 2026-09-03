import {
  AGENT_STREAM_EVENT_TYPES,
  type Approval,
  type ChatAttachment,
  type ChatMessage,
  type CreateSessionResponse,
  type CreateTurnResponse,
  type EventPayload,
  type PersistedStreamEvent,
  type Session,
  type SessionListResponse,
  type StreamEvent,
} from "@agentcore/contracts";

export const DEFAULT_AGENT_API = "http://127.0.0.1:8765";

export const STREAM_EVENTS = AGENT_STREAM_EVENT_TYPES;

export type {
  Approval,
  ChatAttachment,
  ChatMessage,
  CreateSessionResponse,
  CreateTurnResponse,
  EventPayload,
  PersistedStreamEvent,
  Session,
  SessionListResponse,
  StreamEvent,
} from "@agentcore/contracts";

export function eventLabel(type: string): string {
  const labels: Record<string, string> = {
    "session.created": "会话创建",
    "turn.queued": "任务已排队",
    "turn.started": "开始任务",
    "user_interjection": "临时追加",
    "model.requested": "请求模型",
    "assistant.message": "Agent 回复",
    "tool.requested": "准备运行工具",
    "tool.result": "工具完成",
    "approval.requested": "等待审批",
    "approval.resolved": "审批完成",
    "turn.completed": "模型完成",
    "turn.finished": "回合完成",
    "turn.cancelled": "回合已取消",
    "turn.error": "回合错误",
    "turn.cancel.requested": "请求停止",
    "video.progress": "视频解析",
    "video.failed": "视频解析失败",
    "run.plan": "Team 计划",
    "run.started": "成员启动",
    "run.progress": "成员进展",
    "run.completed": "成员完成",
    "run.failed": "成员失败",
  };
  return labels[type] ?? type;
}

function clipDetail(value: string, limit = 6_000): string {
  return value.length > limit ? `${value.slice(0, limit)}\n...（已截断）` : value;
}

export function eventDetail(event: StreamEvent): string | null {
  if (event.type === "user_interjection") {
    const status = String(event.payload.status ?? "received");
    const labels: Record<string, string> = {
      received: "已送达，等待主 Agent 读取",
      injected: "主 Agent 已看到",
      queued: "将在下一条回复处理",
      failed: "未被处理",
    };
    return labels[status] ?? status;
  }
  if (event.type === "turn.queued") {
    return `队列位置：${String(event.payload.position ?? "unknown")} · FIFO`;
  }
  if (event.type === "assistant.message") {
    const phase = String(event.payload.phase ?? "final");
    return phase === "final" ? null : clipDetail(String(event.payload.text ?? ""), 2_000);
  }
  if (event.type === "tool.requested") {
    const toolName = String(event.payload.tool_name ?? "unknown");
    const input = (event.payload.input ?? {}) as Record<string, unknown>;
    const command = input.command;
    return command === undefined
      ? clipDetail(`${toolName}\n${JSON.stringify(input, null, 2)}`, 2_000)
      : clipDetail(`${toolName}\n${String(command)}`, 2_000);
  }
  if (event.type === "tool.result") {
    return clipDetail(String(event.payload.output ?? ""));
  }
  if (event.type === "model.requested") {
    const model = String(event.payload.model ?? "unknown");
    const phase = String(event.payload.phase ?? "agent");
    return `${model} · ${phase} · max_tokens: ${String(event.payload.max_tokens ?? "unknown")}`;
  }
  if (event.type === "turn.error") {
    return `${String(event.payload.error_type ?? "Error")}: ${String(event.payload.message ?? "")}`;
  }
  if (event.type === "turn.cancel.requested") {
    const members = Array.isArray(event.payload.team_members)
      ? event.payload.team_members.filter((member): member is string => typeof member === "string")
      : [];
    return members.length > 0
      ? `Lead 已请求协作式停止\n成员（${members.length}）：${members.join(", ")}`
      : "Lead 已请求停止当前回合";
  }
  if (event.type === "video.progress" || event.type === "video.failed") {
    const attachment = String(event.payload.attachment ?? "视频附件");
    const message = String(event.payload.message ?? "正在处理视频");
    const completed = Number(event.payload.completed);
    const total = Number(event.payload.total);
    const progress = Number.isFinite(completed) && Number.isFinite(total) && total > 0
      ? `（${completed}/${total}）`
      : "";
    const errorCode = String(event.payload.error_code ?? "");
    return `${attachment} · ${message}${progress}${errorCode ? `\n${errorCode}` : ""}`;
  }
  if (event.type === "run.progress") {
    return `${String(event.payload.run_id ?? "unknown")} · ${String(event.payload.phase ?? "working")}\n${String(event.payload.summary ?? "")}`;
  }
  if (event.type === "run.failed") {
    return `${String(event.payload.error_code ?? "Error")}: ${String(event.payload.message ?? "")}`;
  }
  return null;
}
