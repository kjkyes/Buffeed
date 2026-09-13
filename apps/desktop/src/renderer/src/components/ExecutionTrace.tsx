import { memo } from "react";
import { ChevronDown } from "lucide-react";

import { eventDetail as describeEvent, type StreamEvent } from "../domains/agent";
import { terminalPhase, type HUDOperation } from "../domains/hud";
import { durationLabel } from "../utils/format";
import { AgentOperationCard, groupAdjacentOperations } from "./AgentOperationCard";
import { MarkdownContent } from "./MarkdownContent";

type ExecutionTraceProps = {
  events: StreamEvent[];
  operations: HUDOperation[];
  streamingPreviews: Array<{ id: string; text: string; order: number }>;
  baseUrl?: string;
  sessionId?: string | null;
  expanded: boolean;
  active: boolean;
  elapsedSeconds: number | null;
  onToggle: () => void;
};

type TraceItem =
  | { kind: "event"; event: StreamEvent; order: number; position: number }
  | { kind: "operation"; operations: HUDOperation[]; order: number; position: number }
  | { kind: "preview"; preview: { id: string; text: string; order: number }; order: number; position: number };

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

function traceStatusLabel(events: StreamEvent[], operations: HUDOperation[], active: boolean): string {
  const terminal = terminalPhase(events);
  if (terminal === "completed") return "已完成";
  if (terminal === "failed") return "失败";
  if (terminal === "cancelled") return "已取消";
  if (active || operations.some((operation) => operation.status === "running")) return "进行中";
  return "等待完成";
}

function shouldRenderEvent(event: StreamEvent): boolean {
  if (event.type === "assistant.message") {
    return isVisibleThoughtEvent(event);
  }
  return !LIFECYCLE_EVENT_TYPES.has(event.type)
    && !HIDDEN_EVENT_TYPES.has(event.type)
    && !event.type.startsWith("run.")
    && !event.type.startsWith("team.")
    && Boolean(describeEvent(event)?.trim());
}

function isVisibleThoughtEvent(event: StreamEvent): boolean {
  if (event.type !== "assistant.message") return false;
  const phase = String(event.payload.phase ?? "");
  if (!["planning", "finding"].includes(phase)) return false;
  if (
    event.payload.stream_id
    && event.payload.stream_done !== true
    && event.payload.stream_retracted !== true
  ) return false;
  return Boolean(String(event.payload.text ?? "").trim());
}

function eventOrder(event: StreamEvent | undefined): number {
  if (!event) return Number.POSITIVE_INFINITY;
  const numericEventId = Number(event.event_id);
  const streamSeq = Number(event.payload.stream_seq);
  const tieBreaker = Number.isFinite(numericEventId)
    ? numericEventId
    : Number.isFinite(streamSeq) ? streamSeq : 0;
  if (typeof event.createdAt === "number" && Number.isFinite(event.createdAt)) {
    return event.createdAt * 1_000_000 + tieBreaker;
  }
  return Number.MAX_SAFE_INTEGER - 1_000_000 + Math.min(Math.max(tieBreaker, 0), 999_999);
}

function buildTraceItems(
  events: StreamEvent[],
  operations: HUDOperation[],
  streamingPreviews: Array<{ id: string; text: string; order: number }>,
): TraceItem[] {
  const orderedEvents = [...events].sort((left, right) => eventOrder(left) - eventOrder(right));
  const eventsById = new Map(orderedEvents.map((event) => [event.event_id, event]));
  const thoughtOrders = orderedEvents
    .filter(isVisibleThoughtEvent)
    .map((event) => eventOrder(event))
    .sort((left, right) => left - right);
  const operationOrder = (operation: HUDOperation): number => {
    const sourceEvent = eventsById.get(operation.sourceEventId);
    const resultEvent = operation.resultEventId ? eventsById.get(operation.resultEventId) : undefined;
    return eventOrder(sourceEvent ?? resultEvent);
  };
  const groups = groupAdjacentOperations(operations, (previous, current) => {
    const previousOrder = operationOrder(previous);
    const currentOrder = operationOrder(current);
    if (!Number.isFinite(previousOrder) || !Number.isFinite(currentOrder) || currentOrder <= previousOrder) return false;
    return thoughtOrders.some((thoughtOrder) => thoughtOrder > previousOrder && thoughtOrder < currentOrder);
  });
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
  let position = 0;
  orderedEvents.forEach((event) => {
    const order = eventOrder(event);
    if (shouldRenderEvent(event)) {
      items.push({ kind: "event", event, order, position: position++ });
    }
    for (const group of groupsBySource.get(event.event_id) ?? []) {
      items.push({ kind: "operation", operations: group, order, position: position++ });
      anchored.add(group);
    }
  });

  for (const group of groups) {
    if (!anchored.has(group)) {
      const sourceEventId = group[0]?.sourceEventId;
      const sourceEvent = sourceEventId ? eventsById.get(sourceEventId) : undefined;
      const resultEvent = group[0]?.resultEventId ? eventsById.get(group[0].resultEventId) : undefined;
      items.push({
        kind: "operation",
        operations: group,
        order: eventOrder(sourceEvent ?? resultEvent),
        position: position++,
      });
    }
  }

  for (const preview of streamingPreviews) {
    items.push({ kind: "preview", preview, order: preview.order, position: position++ });
  }
  return items.sort((left, right) => left.order - right.order || left.position - right.position);
}

function sameReferences<T>(previous: T[], next: T[]): boolean {
  return previous.length === next.length && previous.every((item, index) => item === next[index]);
}

const ExecutionTrace = memo(function ExecutionTrace({
  events,
  operations,
  streamingPreviews,
  baseUrl,
  sessionId,
  expanded,
  active,
  elapsedSeconds,
  onToggle,
}: ExecutionTraceProps) {
  const items = buildTraceItems(events, operations, streamingPreviews);
  const displayElapsedSeconds = elapsedSeconds ?? eventDurationSeconds(events);
  const statusLabel = traceStatusLabel(events, operations, active);
  return (
    <section className={`execution-trace ${expanded ? "expanded" : "collapsed"}`}>
      <button className="execution-trace-toggle" onClick={onToggle} aria-expanded={expanded}>
        <span className="execution-trace-summary">
          {statusLabel}
          {displayElapsedSeconds !== null && ` · ${durationLabel(displayElapsedSeconds)}`}
        </span>
        <ChevronDown size={15} className="execution-trace-chevron" />
      </button>
      {expanded && (
        <div className="execution-trace-body">
          {items.length === 0 && streamingPreviews.length === 0 && events.length > 0 && <p className="empty-copy">等待可展示的 Agent 事件</p>}
          {items.length === 0 && streamingPreviews.length === 0 && events.length === 0 && <p className="empty-copy">等待 Agent 事件</p>}
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
            if (item.kind === "preview") {
              return (
                <article className="trace-event trace-streaming-preview" key={`streaming-${item.preview.id}`}>
                  <div className="activity-detail">{item.preview.text}</div>
                </article>
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
}, (previous, next) => previous.baseUrl === next.baseUrl
  && previous.sessionId === next.sessionId
  && sameReferences(previous.streamingPreviews, next.streamingPreviews)
  && previous.expanded === next.expanded
  && previous.active === next.active
  && previous.elapsedSeconds === next.elapsedSeconds
  && previous.onToggle === next.onToggle
  && sameReferences(previous.events, next.events)
  && sameReferences(previous.operations, next.operations));

export { ExecutionTrace };
