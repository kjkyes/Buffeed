import { ChevronDown } from "lucide-react";

import { eventDetail as describeEvent, type StreamEvent } from "../domains/agent";
import type { HUDOperation } from "../domains/hud";
import { durationLabel } from "../utils/format";
import { AgentOperationCard, groupAdjacentOperations } from "./AgentOperationCard";
import { MarkdownContent } from "./MarkdownContent";

type ExecutionTraceProps = {
  events: StreamEvent[];
  operations: HUDOperation[];
  baseUrl?: string;
  sessionId?: string | null;
  expanded: boolean;
  active: boolean;
  elapsedSeconds: number | null;
  onToggle: () => void;
};

type TraceItem =
  | { kind: "event"; event: StreamEvent }
  | { kind: "operation"; operations: HUDOperation[] };

const HIDDEN_EVENT_TYPES = new Set([
  "turn.queued",
  "tool.requested",
  "tool.result",
  "run.plan",
  "run.started",
  "run.progress",
  "run.completed",
  "run.failed",
]);

const LIFECYCLE_EVENT_TYPES = new Set([
  "turn.started",
  "model.requested",
  "assistant.message",
  "turn.completed",
  "turn.finished",
]);

const TERMINAL_EVENT_TYPES = new Set(["turn.finished", "turn.cancelled", "turn.error"]);

function eventDurationSeconds(events: StreamEvent[]): number | null {
  const startedAt = events.find((event) => event.type === "turn.started")?.createdAt;
  const finishedAt = [...events]
    .reverse()
    .find((event) => TERMINAL_EVENT_TYPES.has(event.type))?.createdAt;
  if (typeof startedAt !== "number" || typeof finishedAt !== "number") return null;
  return Math.max(0, finishedAt - startedAt);
}

function shouldRenderEvent(event: StreamEvent): boolean {
  if (event.type === "assistant.message") {
    const phase = String(event.payload.phase ?? "");
    if (!["planning", "finding"].includes(phase)) return false;
    if (event.payload.stream_id && event.payload.stream_done !== true) return false;
    return Boolean(String(event.payload.text ?? "").trim());
  }
  return !LIFECYCLE_EVENT_TYPES.has(event.type)
    && !HIDDEN_EVENT_TYPES.has(event.type)
    && !event.type.startsWith("run.")
    && !event.type.startsWith("team.");
}

function buildTraceItems(events: StreamEvent[], operations: HUDOperation[]): TraceItem[] {
  const groups = groupAdjacentOperations(operations);
  const groupsBySource = new Map<string, HUDOperation[][]>();
  for (const group of groups) {
    const sourceEventId = group[0]?.sourceEventId;
    if (!sourceEventId) continue;
    const sourceGroups = groupsBySource.get(sourceEventId) ?? [];
    sourceGroups.push(group);
    groupsBySource.set(sourceEventId, sourceGroups);
  }

  const anchored = new Set<HUDOperation[]>();
  const items: TraceItem[] = [];
  events.forEach((event) => {
    if (shouldRenderEvent(event)) {
      items.push({ kind: "event", event });
    }
    for (const group of groupsBySource.get(event.event_id) ?? []) {
      items.push({ kind: "operation", operations: group });
      anchored.add(group);
    }
  });

  for (const group of groups) {
    if (!anchored.has(group)) {
      items.push({ kind: "operation", operations: group });
    }
  }
  return items;
}

export function ExecutionTrace({
  events,
  operations,
  baseUrl,
  sessionId,
  expanded,
  active,
  elapsedSeconds,
  onToggle,
}: ExecutionTraceProps) {
  const items = buildTraceItems(events, operations);
  const displayElapsedSeconds = elapsedSeconds ?? eventDurationSeconds(events);
  return (
    <section className={`execution-trace ${expanded ? "expanded" : "collapsed"}`}>
      <button className="execution-trace-toggle" onClick={onToggle} aria-expanded={expanded}>
        <span className="execution-trace-summary">
          {active ? "进行中" : "已完成"}
          {displayElapsedSeconds !== null && ` · ${durationLabel(displayElapsedSeconds)}`}
        </span>
        <ChevronDown size={15} className="execution-trace-chevron" />
      </button>
      {expanded && (
        <div className="execution-trace-body">
          {items.length === 0 && events.length > 0 && <p className="empty-copy">等待可展示的 Agent 事件</p>}
          {items.length === 0 && events.length === 0 && <p className="empty-copy">等待 Agent 事件</p>}
          {items.map((item, itemIndex) => {
            if (item.kind === "operation") {
              const first = item.operations[0];
              return (
                <AgentOperationCard
                  operations={item.operations}
                  baseUrl={baseUrl}
                  sessionId={sessionId}
                  key={`operation-${first?.id ?? itemIndex}`}
                />
              );
            }
            const { event } = item;
            const detail = describeEvent(event);
            return (
              <article className={`trace-event ${event.type.replaceAll(".", "-")}`} key={event.event_id}>
                {detail && <div className="activity-detail"><MarkdownContent text={detail} /></div>}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
