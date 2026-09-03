import type { StreamEvent } from "./agent";

export type HUDOperationKind = "command" | "edit" | "review" | "request" | "read" | "team" | "other";
export type HUDOperationStatus = "running" | "completed" | "failed";
export type HUDStepStatus = "pending" | "running" | "completed" | "failed";

export type HUDStep = {
  id: string;
  title: string;
  status: HUDStepStatus;
};

export type HUDDiffLine = {
  kind: "context" | "addition" | "deletion";
  oldLine?: number;
  newLine?: number;
  text: string;
};

export type HUDFileChange = {
  path: string;
  additions: number;
  deletions: number;
  hunks: Array<{ startLine: number; endLine: number }>;
  diffLines?: HUDDiffLine[];
  status?: string;
};

export type HUDOperation = {
  id: string;
  kind: HUDOperationKind;
  status: HUDOperationStatus;
  toolName: string;
  path?: string;
  command?: string;
  durationSeconds?: number;
  inputSummary?: string;
  stepCount?: number;
  sourceEventId: string;
  resultEventId?: string;
  detailEventIds?: string[];
  detailPending?: boolean;
  detail: string;
  verificationBadge?: string;
};

export type TaskHUDPhase = "idle" | "running" | "completed" | "failed" | "cancelled";

export type TaskHUDState = {
  currentStep: number;
  totalSteps: number;
  steps: HUDStep[];
  fileChanges: HUDFileChange[];
  operations: HUDOperation[];
  summary: {
    totalFiles: number;
    totalAdditions: number;
    totalDeletions: number;
  } | null;
  phase: TaskHUDPhase;
  cancellationNote: boolean;
};

const MAX_DETAIL_LENGTH = 3_000;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function clip(value: string): string {
  return value.length > MAX_DETAIL_LENGTH ? `${value.slice(0, MAX_DETAIL_LENGTH)}\n...（已截断）` : value;
}

function durationSeconds(startedAt: number | null, finishedAt: number | null): number | undefined {
  if (typeof startedAt !== "number" || typeof finishedAt !== "number") return undefined;
  return Math.max(0, Math.round(finishedAt - startedAt));
}

function classify(toolName: string, input: Record<string, unknown>): HUDOperationKind {
  const normalized = toolName.toLowerCase();
  const command = text(input.command ?? input.cmd).toLowerCase();
  if (normalized === "bash" || normalized === "run_bash" || normalized === "shell") {
    return /\b(review|audit|审查)\b/.test(command) ? "review" : "command";
  }
  if (["write_file", "edit_file", "apply_patch"].includes(normalized)) {
    return "edit";
  }
  if (["read_file", "glob", "list_files"].includes(normalized)) {
    return "read";
  }
  if ([
    "spawn_teammate",
    "spawn_subagent",
    "task",
    "create_task",
    "assign_task",
    "complete_task",
    "send_message",
    "await_team_result",
    "inspect_team_tasks",
    "takeover_task",
  ].includes(normalized)) {
    return "team";
  }
  if (normalized.includes("rag") || normalized.includes("mcp") || normalized.includes("http") || normalized.includes("request")) {
    return "request";
  }
  return "other";
}

function inputSummary(toolName: string, input: Record<string, unknown>): { summary?: string; stepCount?: number } {
  const normalized = toolName.toLowerCase();
  if (normalized === "todo_write" && Array.isArray(input.todos)) {
    const todos = input.todos.map((todo) => record(todo));
    return {
      stepCount: todos.length,
      summary: todos.map((todo) => {
        const status = text(todo.status);
        const marker = status === "completed" ? "☑" : status === "in_progress" ? "◐" : "☐";
        return `${marker} ${text(todo.content) || "未命名待办"}`;
      }).join("\n"),
    };
  }
  if (["spawn_teammate", "spawn_subagent", "task"].includes(normalized)) {
    const name = text(input.name ?? input.agent_name ?? input.description);
    const role = text(input.role);
    const prompt = text(input.prompt ?? input.task);
    return { summary: [name && `成员：${name}`, role && `角色：${role}`, prompt].filter(Boolean).join("\n") };
  }
  if (normalized === "load_skill") {
    return { summary: text(input.name ?? input.skill ?? input.path) || "加载 bundled skill" };
  }
  if (normalized.includes("memory")) {
    return { summary: text(input.query ?? input.path ?? input.key) || "加载记忆片段" };
  }
  const command = text(input.command ?? input.cmd);
  const path = pathFromInput(input);
  return { summary: command || path || undefined };
}

function pathFromInput(input: Record<string, unknown>): string | undefined {
  const value = input.path ?? input.file_path ?? input.filename;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function verificationBadge(toolName: string, output: string): string | undefined {
  const passed = output.match(/(\d+)\s+passed\b/i);
  if (passed) {
    return `${passed[1]} passed`;
  }
  if (/compileall|compiled successfully/i.test(output) || /compileall/i.test(toolName)) {
    return "compileall";
  }
  if (/CodeGraph.*(OK|正常|up to date)/i.test(output)) {
    return "CodeGraph 正常";
  }
  return undefined;
}

function stepsFromEvent(event: StreamEvent): HUDStep[] | null {
  if (event.type !== "tool.requested" || text(event.payload.tool_name) !== "todo_write") {
    return null;
  }
  const input = record(event.payload.input);
  if (!Array.isArray(input.todos)) {
    return null;
  }
  return input.todos.map((todo, index) => {
    const item = record(todo);
    const status = text(item.status);
    return {
      id: `${event.turnId ?? "turn"}:step:${index}`,
      title: text(item.content) || `步骤 ${index + 1}`,
      status: status === "in_progress" ? "running" : status === "completed" ? "completed" : status === "failed" ? "failed" : "pending",
    };
  });
}

function mergeOperations(operations: HUDOperation[]): HUDOperation[] {
  const merged: HUDOperation[] = [];
  for (const operation of operations) {
    const previous = merged.at(-1);
    if (
      previous
      && previous.kind === "edit"
      && operation.kind === "edit"
      && previous.path
      && previous.path === operation.path
      && previous.status === "completed"
      && operation.status === "completed"
    ) {
      previous.detail = [previous.detail, operation.detail].filter(Boolean).join("\n");
      previous.verificationBadge = operation.verificationBadge ?? previous.verificationBadge;
      previous.detailEventIds = [
        ...(previous.detailEventIds ?? [previous.sourceEventId]),
        ...(operation.detailEventIds ?? [operation.sourceEventId]),
      ];
      previous.detailPending = previous.detailPending || operation.detailPending;
      continue;
    }
    merged.push({ ...operation });
  }
  return merged;
}

export function deriveTaskHUD(
  events: StreamEvent[],
  fileChanges: HUDFileChange[],
  active: boolean,
): TaskHUDState {
  const operations: HUDOperation[] = [];
  let steps: HUDStep[] = [];
  let phase: TaskHUDPhase = active ? "running" : "idle";
  let cancellationNote = false;
  const operationIndexes = new Map<string, number>();

  for (const event of events) {
    if (event.type === "turn.cancel.requested") {
      cancellationNote = true;
      if (active) phase = "running";
    }
    if (event.type === "turn.cancelled") {
      phase = "cancelled";
    }
    if (event.type === "turn.error") {
      phase = "failed";
    }
    if (event.type === "turn.finished") {
      const status = text(event.payload.status);
      phase = status === "cancelled" ? "cancelled" : status === "error" ? "failed" : "completed";
    }
    const nextSteps = stepsFromEvent(event);
    if (nextSteps) steps = nextSteps;
    if (event.type === "tool.requested") {
      const input = record(event.payload.input);
      const toolName = text(event.payload.tool_name) || "unknown";
      const operationId = `${event.turnId ?? "turn"}:${text(event.payload.tool_use_id) || event.event_id}`;
      const kind = classify(toolName, input);
      const path = pathFromInput(input);
      const command = text(input.command ?? input.cmd) || undefined;
      const inputDetails = inputSummary(toolName, input);
      operationIndexes.set(operationId, operations.length);
      operations.push({
        id: operationId,
        kind,
        status: "running",
        toolName,
        path,
        command,
        durationSeconds: undefined,
        inputSummary: inputDetails.summary,
        stepCount: inputDetails.stepCount,
        sourceEventId: event.event_id,
        detailEventIds: [event.event_id],
        detailPending: record(event.payload)._summary === true,
        detail: inputDetails.summary ?? toolName,
      });
    }
    if (event.type === "tool.result") {
      const operationId = `${event.turnId ?? "turn"}:${text(event.payload.tool_use_id) || event.event_id}`;
      const index = operationIndexes.get(operationId);
      const output = clip(text(event.payload.output));
      if (index === undefined) {
        const toolName = text(event.payload.tool_name) || "unknown";
        operations.push({
          id: operationId,
          kind: classify(toolName, record(event.payload.input)),
          status: output.startsWith("Error:") ? "failed" : "completed",
          toolName,
          path: pathFromInput(record(event.payload.input)),
          inputSummary: inputSummary(toolName, record(event.payload.input)).summary,
          stepCount: inputSummary(toolName, record(event.payload.input)).stepCount,
          sourceEventId: event.event_id,
          resultEventId: event.event_id,
          detailEventIds: [event.event_id],
          detailPending: record(event.payload)._summary === true,
          detail: output,
          verificationBadge: verificationBadge(toolName, output),
        });
      } else {
        const operation = operations[index];
        operation.status = output.startsWith("Error:") ? "failed" : "completed";
        operation.durationSeconds = durationSeconds(
          events.find((candidate) => candidate.event_id === operation.sourceEventId)?.createdAt ?? null,
          event.createdAt,
        );
        operation.resultEventId = event.event_id;
        operation.detailEventIds = Array.from(new Set([
          ...(operation.detailEventIds ?? [operation.sourceEventId]),
          event.event_id,
        ]));
        operation.detailPending = operation.detailPending || record(event.payload)._summary === true;
        operation.detail = output || operation.detail;
        operation.verificationBadge = verificationBadge(operation.toolName, output);
      }
    }
  }

  const terminalEvent = [...events].reverse().find((event) => (
    event.type === "turn.finished" || event.type === "turn.cancelled" || event.type === "turn.error"
  ));
  if (terminalEvent) {
    const terminalStatus = terminalEvent.type === "turn.error" || terminalEvent.type === "turn.cancelled"
      ? "failed"
      : ["error", "cancelled"].includes(text(terminalEvent.payload.status))
        ? "failed"
        : "completed";
    const terminalDetail = terminalEvent.type === "turn.error"
      ? `${text(terminalEvent.payload.error_type) || "Error"}: ${text(terminalEvent.payload.message) || "回合已中断"}`
      : terminalEvent.type === "turn.cancelled"
        ? "回合已取消"
        : terminalStatus === "failed" ? "回合执行失败" : "回合已完成";
    for (const operation of operations) {
      if (operation.status !== "running") continue;
      operation.status = terminalStatus;
      operation.durationSeconds = durationSeconds(
        events.find((candidate) => candidate.event_id === operation.sourceEventId)?.createdAt ?? null,
        terminalEvent.createdAt,
      );
      operation.detailEventIds = Array.from(new Set([
        ...(operation.detailEventIds ?? [operation.sourceEventId]),
        terminalEvent.event_id,
      ]));
      operation.detail = [operation.detail, terminalDetail].filter(Boolean).join("\n");
    }
  }

  if (!active && phase === "idle" && operations.length > 0) phase = "completed";
  const currentIndex = steps.findIndex((step) => ["running", "failed", "pending"].includes(step.status));
  const currentStep = steps.length === 0 ? 0 : currentIndex >= 0 ? currentIndex + 1 : steps.length;
  const summary = fileChanges.length > 0
    ? {
        totalFiles: fileChanges.length,
        totalAdditions: fileChanges.reduce((total, file) => total + file.additions, 0),
        totalDeletions: fileChanges.reduce((total, file) => total + file.deletions, 0),
      }
    : null;
  return {
    currentStep,
    totalSteps: steps.length,
    steps,
    fileChanges,
    operations: mergeOperations(operations),
    summary,
    phase,
    cancellationNote,
  };
}
