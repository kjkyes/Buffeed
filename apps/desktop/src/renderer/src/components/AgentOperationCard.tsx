import {
  ChevronDown,
  ClipboardCheck,
  FileCode2,
  Files,
  Globe2,
  ListChecks,
  Terminal,
  UsersRound,
} from "lucide-react";
import { useState } from "react";

import type { PersistedStreamEvent } from "../domains/agent";
import type { HUDOperation, HUDOperationKind } from "../domains/hud";
import { getEventDetail } from "../services/agentApi";

function compactSubject(operation: HUDOperation): string {
  const subject = (operation.command || operation.path || operation.toolName).replace(/\s+/g, " ").trim();
  return subject.length > 96 ? `${subject.slice(0, 93)}...` : subject;
}

function commandSubject(operation: HUDOperation): string {
  const subject = compactSubject(operation);
  return operation.durationSeconds === undefined
    ? subject
    : `已在 ${operation.durationSeconds}s 内运行 ${subject}`;
}

function teamOperationFamily(toolName: string): "spawn" | "message" | "task" | "wait" | "monitor" | "other" {
  const normalized = toolName.toLowerCase();
  if (["spawn_teammate", "spawn_subagent", "task"].includes(normalized)) return "spawn";
  if (normalized === "send_message") return "message";
  if (["create_task", "assign_task", "complete_task"].includes(normalized)) return "task";
  if (normalized === "await_team_result") return "wait";
  if (["inspect_team_tasks", "takeover_task"].includes(normalized)) return "monitor";
  return "other";
}

function operationTitle(operation: HUDOperation, batchSize = 1): string {
  const subject = compactSubject(operation);
  if (operation.toolName === "todo_write") {
    return operation.status === "running"
      ? `正在更新 ${operation.stepCount ?? 0} 个 todos`
      : `更新了 ${operation.stepCount ?? 0} 个 todos`;
  }
  if (operation.toolName === "load_skill") {
    return operation.status === "running" ? "正在加载 Skill" : "加载了 Skill";
  }
  if (operation.toolName.toLowerCase().includes("memory")) {
    return operation.status === "running" ? "正在加载记忆片段" : "加载了记忆片段";
  }
  if (operation.status === "running") {
    if (operation.kind === "command") return batchSize > 1 ? `正在运行 ${batchSize} 条命令` : `正在运行 '${subject}'`;
    if (operation.kind === "edit") return batchSize > 1 ? `正在批量编辑 ${batchSize} 个文件` : `正在编辑 '${subject}'`;
    if (operation.kind === "review") return `Review '${subject}'`;
    if (operation.kind === "team") {
      const family = teamOperationFamily(operation.toolName);
      if (family === "spawn") return batchSize > 1 ? `正在生成 ${batchSize} 个 Agent Team 成员` : "正在生成 Agent Team";
      if (family === "message") return batchSize > 1 ? `正在分发 ${batchSize} 条 Team 消息` : "正在分发 Team 消息";
      if (family === "task") return batchSize > 1 ? `正在处理 ${batchSize} 个 Team 任务` : "正在处理 Team 任务";
      if (family === "wait") return batchSize > 1 ? `正在等待 ${batchSize} 组成员结果` : "正在等待成员结果";
      return batchSize > 1 ? `正在执行 ${batchSize} 个 Team 操作` : "正在执行 Team 操作";
    }
    if (operation.kind === "read") return batchSize > 1 ? `正在读取 ${batchSize} 个文件` : `正在读取 '${subject}'`;
    if (operation.kind === "request") return batchSize > 1 ? `正在处理 ${batchSize} 个请求` : `正在请求 '${subject}'`;
    return `正在执行 '${subject}'`;
  }
  if (operation.kind === "command") return batchSize > 1 ? `运行了 ${batchSize} 条命令` : commandSubject(operation);
  if (operation.kind === "edit") return batchSize > 1 ? `编辑了 ${batchSize} 个文件` : `编辑了文件 · ${subject}`;
  if (operation.kind === "review") return "已审阅";
  if (operation.kind === "team") {
    const family = teamOperationFamily(operation.toolName);
    if (family === "spawn") return operation.stepCount ? `生成了 Agent Team（${operation.stepCount} 个成员）` : "生成了 Agent Team";
    if (family === "message") return batchSize > 1 ? `分发了 ${batchSize} 条 Team 消息` : "分发了 Team 消息";
    if (family === "task") return batchSize > 1 ? `处理了 ${batchSize} 个 Team 任务` : "处理了 Team 任务";
    if (family === "wait") return batchSize > 1 ? `等待了 ${batchSize} 组成员结果` : "等待了成员结果";
    return batchSize > 1 ? `执行了 ${batchSize} 个 Team 操作` : "执行了 Team 操作";
  }
  if (operation.kind === "read") return batchSize > 1 ? `读取了 ${batchSize} 个文件` : `读取了文件 · ${subject}`;
  if (operation.kind === "request") return batchSize > 1 ? `完成了 ${batchSize} 个请求` : `完成了网络请求 · ${subject}`;
  return "操作完成";
}

function operationIcon(kind: HUDOperationKind) {
  if (kind === "command") return <Terminal size={13} />;
  if (kind === "edit") return <FileCode2 size={13} />;
  if (kind === "review") return <ClipboardCheck size={13} />;
  if (kind === "request") return <Globe2 size={13} />;
  if (kind === "team") return <UsersRound size={13} />;
  if (kind === "read") return <Files size={13} />;
  return <ListChecks size={13} />;
}

function operationEntryTitle(operation: HUDOperation): string {
  if (operation.kind === "command" && operation.durationSeconds !== undefined) {
    return commandSubject(operation);
  }
  return operation.path ?? operation.command ?? operation.toolName;
}

export function groupAdjacentOperations(operations: HUDOperation[]): HUDOperation[][] {
  const groups: HUDOperation[][] = [];
  for (const operation of operations) {
    const previous = groups.at(-1);
    const previousOperation = previous?.[0];
    const previousKey = previousOperation
      ? previousOperation.kind === "team"
        ? `team:${teamOperationFamily(previousOperation.toolName)}`
        : previousOperation.kind === "other"
          ? `other:${previousOperation.toolName}`
          : previousOperation.kind
      : null;
    const operationKey = operation.kind === "team"
      ? `team:${teamOperationFamily(operation.toolName)}`
      : operation.kind === "other"
        ? `other:${operation.toolName}`
        : operation.kind;
    if (previous && previousKey === operationKey) {
      previous.push(operation);
    } else {
      groups.push([operation]);
    }
  }
  return groups;
}

type OperationDetail = {
  input?: string;
  output?: string;
  loading?: boolean;
  error?: string;
};

type AgentOperationCardProps = {
  operations: HUDOperation[];
  baseUrl?: string;
  sessionId?: string | null;
};

function formatInput(event: PersistedStreamEvent): string | undefined {
  const payload = event.payload as Record<string, unknown>;
  const input = payload.input;
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const command = record.command ?? record.cmd;
  if (command !== undefined) {
    return `${event.event_type}\n${String(command)}`;
  }
  return `${event.event_type}\n${JSON.stringify(input, null, 2)}`;
}

async function fetchOperationDetail(
  operation: HUDOperation,
  baseUrl: string,
  sessionId: string,
): Promise<OperationDetail> {
  const eventIds = [...new Set([
    ...(operation.detailEventIds ?? []),
    operation.sourceEventId,
    operation.resultEventId,
  ].filter((eventId): eventId is string => Boolean(eventId)))];
  const events = await Promise.all(eventIds.map((eventId) => getEventDetail(baseUrl, sessionId, eventId)));
  const inputs: string[] = [];
  const outputs: string[] = [];
  const detail: OperationDetail = {};
  for (const event of events) {
    if (event.event_type === "tool.requested") {
      const input = formatInput(event);
      if (input) inputs.push(input);
    } else if (event.event_type === "tool.result") {
      outputs.push(String(event.payload.output ?? ""));
    }
  }
  if (inputs.length > 0) detail.input = inputs.join("\n\n");
  if (outputs.length > 0) detail.output = outputs.join("\n\n");
  return detail;
}

export function AgentOperationCard({ operations, baseUrl, sessionId }: AgentOperationCardProps) {
  const [open, setOpen] = useState(false);
  const [openEntryIds, setOpenEntryIds] = useState<Record<string, boolean>>({});
  const [details, setDetails] = useState<Record<string, OperationDetail>>({});
  const first = operations[0];
  const running = operations.some((operation) => operation.status === "running");
  const failed = operations.some((operation) => operation.status === "failed");
  const title = operationTitle(first, operations.length);

  const loadDetail = async (operation: HUDOperation): Promise<void> => {
    if (!baseUrl || !sessionId || !operation.detailPending || details[operation.id]) {
      return;
    }
    setDetails((current) => ({
      ...current,
      [operation.id]: { loading: true },
    }));
    try {
      const detail = await fetchOperationDetail(operation, baseUrl, sessionId);
      setDetails((current) => ({ ...current, [operation.id]: detail }));
    } catch (error) {
      setDetails((current) => ({
        ...current,
        [operation.id]: {
          error: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  };

  const toggle = (): void => {
    setOpen((current) => !current);
  };

  const toggleEntry = (operation: HUDOperation): void => {
    const nextOpen = !openEntryIds[operation.id];
    setOpenEntryIds((current) => ({ ...current, [operation.id]: nextOpen }));
    if (nextOpen) {
      void loadDetail(operation);
    }
  };

  return (
    <article className={`trace-operation-card status-${running ? "running" : failed ? "failed" : "completed"}`}>
      <button className="trace-operation-toggle" type="button" aria-expanded={open} onClick={toggle}>
        <span className="trace-operation-icon">{operationIcon(first.kind)}</span>
        <span className="trace-operation-title">{title}</span>
        {first.verificationBadge && <small className="hud-verification-badge">{first.verificationBadge}</small>}
        <ChevronDown size={13} className={open ? "expanded" : ""} />
      </button>
      {open && (
        <div className="trace-operation-detail">
          {operations.map((operation) => {
            const entryOpen = Boolean(openEntryIds[operation.id]);
            const detail = details[operation.id];
            const input = detail?.input ?? operation.inputSummary;
            const output = detail?.output ?? operation.detail;
            return (
              <div className="trace-operation-entry" key={operation.id}>
                <button
                  className="trace-operation-entry-toggle"
                  type="button"
                  title={operationEntryTitle(operation)}
                  aria-expanded={entryOpen}
                  onClick={() => toggleEntry(operation)}
                >
                  <span>{operationEntryTitle(operation)}</span>
                  {operation.verificationBadge && <small className="hud-verification-badge">{operation.verificationBadge}</small>}
                  <ChevronDown size={13} className={entryOpen ? "expanded" : ""} />
                </button>
                {entryOpen && (
                  <div className="trace-operation-entry-detail">
                    {input && <pre className="trace-operation-input">{input}</pre>}
                    {output && output !== input && <pre>{output}</pre>}
                    {detail?.loading && <small className="trace-operation-loading">正在加载详情…</small>}
                    {detail?.error && <small className="trace-operation-error">详情加载失败：{detail.error}</small>}
                  </div>
                )}
            </div>
            );
          })}
        </div>
      )}
    </article>
  );
}
