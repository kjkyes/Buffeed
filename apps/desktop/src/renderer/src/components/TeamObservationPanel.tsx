import { ChevronDown, Filter, Network } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { eventLabel } from "../domains/agent";
import type { TeamObservation, TeamObservationEvent } from "../domains/team";
import { buildExecutionIR, type ExecutionIRNode } from "../domains/teamScene";
import { TeamGraphCanvas } from "./TeamGraphCanvas";

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    running: "运行中",
    working: "处理中",
    in_progress: "进行中",
    pending: "等待中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
    idle: "空闲",
  };
  return labels[status] ?? status;
}

type TeamStatusFilter = "all" | "active" | "completed" | "failed";

const STATUS_FILTERS: Array<{ id: TeamStatusFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "active", label: "进行中" },
  { id: "completed", label: "已完成" },
  { id: "failed", label: "失败/取消" },
];

function matchesStatusFilter(status: string, filter: TeamStatusFilter): boolean {
  if (filter === "all") {
    return true;
  }
  if (filter === "active") {
    return ["running", "working", "in_progress"].includes(status);
  }
  if (filter === "completed") {
    return status === "completed";
  }
  return ["failed", "cancelled"].includes(status);
}

function taskOwner(owner: string | null | undefined): string {
  return owner === "agent" || !owner ? "lead" : owner;
}

function eventSummary(event: TeamObservationEvent): string {
  const payload = event.payload;
  if (event.event_type === "run.plan") {
    return `${Array.isArray(payload.members) ? payload.members.length : 0} 名成员 · ${Array.isArray(payload.tasks) ? payload.tasks.length : 0} 个任务`;
  }
  if (event.event_type === "run.progress") {
    return `${String(payload.run_id ?? "成员")} · ${String(payload.phase ?? "working")} · ${String(payload.summary ?? "")}`;
  }
  if (event.event_type === "run.failed") {
    return `${String(payload.run_id ?? "成员")} · ${String(payload.message ?? payload.error_code ?? "失败")}`;
  }
  return String(payload.run_id ?? "");
}

function eventTime(event: TeamObservationEvent): string {
  return new Date(event.created_at * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function payloadRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    : [];
}

function payloadText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function DetailRow({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return (
    <div className="team-inspector-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function EventFact({ label, value }: { label: string; value: string | number | undefined }) {
  if (value === undefined || value === "") {
    return null;
  }
  return (
    <div className="team-event-detail-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function EventDetailTarget(
  event: TeamObservationEvent,
  nodes: ExecutionIRNode[],
): string | null {
  const runId = typeof event.payload.run_id === "string" ? event.payload.run_id : null;
  if (runId) {
    const member = nodes.find(
      (node) => node.kind === "member" && (node.id === `member:${runId}` || node.label === runId),
    );
    if (member) {
      return member.id;
    }
  }
  const taskId = typeof event.payload.task_id === "string" ? event.payload.task_id : null;
  if (taskId) {
    const task = nodes.find((node) => node.kind === "task" && node.taskId === taskId);
    return task?.id ?? null;
  }
  if (event.event_type === "run.plan") {
    return nodes.find((node) => node.kind === "member" && node.role === "lead")?.id ?? null;
  }
  return null;
}

export function TeamObservationPanel({
  observation,
  error,
}: {
  observation: TeamObservation | null;
  error?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<TeamStatusFilter>("all");
  const [expandedEventIds, setExpandedEventIds] = useState<Set<number>>(() => new Set());
  const previousExecutionRef = useRef<string | null>(null);
  const execution = useMemo(() => buildExecutionIR(observation), [observation]);
  const events = (observation?.events ?? []).slice(-12).reverse();

  useEffect(() => {
    if (observation?.available && observation.execution_id !== previousExecutionRef.current) {
      setExpanded(true);
      setExpandedEventIds(new Set());
    }
    previousExecutionRef.current = observation?.execution_id ?? null;
  }, [observation?.available, observation?.execution_id]);

  useEffect(() => {
    if (!execution || !selectedNodeId || !execution.nodes.some((node) => node.id === selectedNodeId && matchesStatusFilter(node.status, statusFilter))) {
      setSelectedNodeId(null);
    }
  }, [execution, selectedNodeId, statusFilter]);

  return (
    <section className="detail-section team-observation" aria-label="协作观测">
      <button
        className="team-observation-toggle"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <Network size={16} />
        <span>协作观测</span>
        <small className="read-only-badge">只读</small>
        <ChevronDown size={15} className={`team-observation-chevron ${expanded ? "expanded" : ""}`} />
      </button>
      {error && <p className="team-observation-warning">Team 观测同步暂时失败：{error}</p>}
      {expanded && !execution && (
        <p className="team-observation-empty">当前会话没有可观测的真实 Team run 事件</p>
      )}
      {expanded && execution && (() => {
        const memberNodes = execution.nodes.filter((node) => node.kind === "member");
        const visibleNodeIds = new Set(
          execution.nodes
            .filter((node) => matchesStatusFilter(node.status, statusFilter))
            .map((node) => node.id),
        );
        const selectedNode = selectedNodeId && visibleNodeIds.has(selectedNodeId)
          ? execution.nodes.find((node) => node.id === selectedNodeId) ?? null
          : null;
        return (
          <>
            <p className="team-observation-summary">
              {memberNodes.length > 0 ? "显示真实成员、任务和最近事件" : "显示真实任务状态"}
              {observation?.event_cursor ? ` · 游标 ${observation.event_cursor}` : ""}
            </p>
            <div className="team-canvas-controls" aria-label="Team 画布筛选">
              <span className="team-canvas-filter-label"><Filter size={13} />状态</span>
              <div className="team-filter-segment" role="group" aria-label="按状态筛选">
                {STATUS_FILTERS.map((filter) => (
                  <button
                    key={filter.id}
                    className={`team-filter-option${statusFilter === filter.id ? " is-active" : ""}`}
                    type="button"
                    aria-pressed={statusFilter === filter.id}
                    onClick={() => {
                      setStatusFilter(filter.id);
                      setSelectedNodeId(null);
                    }}
                  >
                    {filter.label}
                  </button>
                ))}
              </div>
              {statusFilter !== "all" && (
                <small className="team-filter-count">{visibleNodeIds.size}/{execution.nodes.length} 个节点</small>
              )}
            </div>
            <TeamGraphCanvas
              execution={execution}
              visibleNodeIds={visibleNodeIds}
              selectedNodeId={selectedNodeId}
              onSelect={setSelectedNodeId}
            />
            <div className="team-canvas-legend" aria-label="关系图例">
              <span><i className="legend-line owner-line" />成员归属</span>
              <span><i className="legend-line dependency-line" />任务依赖</span>
              <span><i className="legend-line delegate-line" />成员委派</span>
              <span><i className="legend-line continuation-line" />执行接续</span>
              <span><i className="legend-line execution-flow-line" />执行流</span>
              <span><i className="legend-line unknown-line" />其他关系</span>
            </div>
            {selectedNode && (
              <aside className="team-inspector" aria-label={`${selectedNode.kind === "member" ? "成员" : "任务"}详情`}>
                <div className="team-inspector-heading">
                  <strong>{selectedNode.kind === "member" ? "成员详情" : "任务详情"}</strong>
                  <button type="button" className="team-inspector-close" onClick={() => setSelectedNodeId(null)} aria-label="关闭详情">×</button>
                </div>
                <h4>{selectedNode.label}</h4>
                <dl>
                  <DetailRow label="状态" value={statusLabel(selectedNode.status)} />
                  {selectedNode.kind === "member" ? (
                    <>
                      <DetailRow label="角色" value={selectedNode.role} />
                      <DetailRow label="任务" value={selectedNode.taskId} />
                      <DetailRow label="阶段" value={selectedNode.phase} />
                      <DetailRow label="工具" value={selectedNode.toolName} />
                      <DetailRow label="耗时" value={selectedNode.durationMs !== undefined ? `${selectedNode.durationMs} ms` : undefined} />
                      <DetailRow label="摘要" value={selectedNode.summary} />
                      <DetailRow label="错误" value={selectedNode.error ? `${selectedNode.errorCode ? `${selectedNode.errorCode}: ` : ""}${selectedNode.error}` : undefined} />
                    </>
                  ) : (
                    <>
                      <DetailRow label="任务 ID" value={selectedNode.taskId} />
                      <DetailRow label="负责人" value={taskOwner(selectedNode.owner)} />
                      <DetailRow label="描述" value={selectedNode.description} />
                      <DetailRow label="依赖" value={selectedNode.dependsOn?.join(", ")} />
                    </>
                  )}
                </dl>
              </aside>
            )}
            {events.length > 0 && (
              <ol className="team-event-timeline" aria-label="Team 事件">
                {events.map((event) => {
                  const target = EventDetailTarget(event, execution.nodes);
                  const eventExpanded = expandedEventIds.has(event.event_id);
                  const members = payloadRecords(event.payload.members);
                  const tasks = payloadRecords(event.payload.tasks);
                  const edges = payloadRecords(event.payload.edges);
                  return (
                    <li key={event.event_id} className={eventExpanded ? "is-expanded" : undefined}>
                      <time>{eventTime(event)}</time>
                      <div className="team-event-entry">
                        <button
                          className="team-event-button"
                          type="button"
                          aria-expanded={eventExpanded}
                          onClick={() => {
                            setExpandedEventIds((current) => {
                              const next = new Set(current);
                              if (next.has(event.event_id)) {
                                next.delete(event.event_id);
                              } else {
                                next.add(event.event_id);
                              }
                              return next;
                            });
                            if (target) {
                              const targetNode = execution.nodes.find((node) => node.id === target);
                              if (targetNode && !matchesStatusFilter(targetNode.status, statusFilter)) {
                                setStatusFilter("all");
                              }
                              setSelectedNodeId(target);
                            }
                          }}
                        >
                          <span className="team-event-title">
                            <strong>{eventLabel(event.event_type)}</strong>
                            <ChevronDown size={12} className={`team-event-chevron${eventExpanded ? " expanded" : ""}`} />
                          </span>
                          <small>{eventSummary(event)}</small>
                        </button>
                        {eventExpanded && (
                          <div className="team-event-details">
                            <dl>
                              <EventFact label="事件 ID" value={event.event_id} />
                              <EventFact label="类型" value={event.event_type} />
                              <EventFact label="execution" value={payloadText(event.payload.execution_id)} />
                              <EventFact label="成员" value={payloadText(event.payload.run_id)} />
                              <EventFact label="任务" value={payloadText(event.payload.task_id)} />
                              <EventFact label="阶段" value={payloadText(event.payload.phase)} />
                              <EventFact label="工具" value={payloadText(event.payload.tool_name)} />
                              <EventFact label="耗时" value={payloadText(event.payload.duration_ms)} />
                              <EventFact label="摘要" value={payloadText(event.payload.summary)} />
                              <EventFact label="错误码" value={payloadText(event.payload.error_code)} />
                              <EventFact label="消息" value={payloadText(event.payload.message)} />
                            </dl>
                            {event.event_type === "run.plan" && (members.length > 0 || tasks.length > 0 || edges.length > 0) && (
                              <div className="team-event-plan-details">
                                <strong>计划内容</strong>
                                {members.length > 0 && (
                                  <ul>
                                    {members.map((member, index) => (
                                      <li key={`${String(member.run_id ?? member.name ?? "member")}-${index}`}>
                                        成员：{String(member.name ?? member.run_id ?? "未命名")}{member.role ? ` · ${String(member.role)}` : ""}
                                      </li>
                                    ))}
                                  </ul>
                                )}
                                {tasks.length > 0 && (
                                  <ul>
                                    {tasks.map((task, index) => (
                                      <li key={`${String(task.task_id ?? task.id ?? "task")}-${index}`}>
                                        任务：{String(task.subject ?? task.task_id ?? task.id ?? "未命名")}{task.owner ? ` · 负责人 ${String(task.owner)}` : ""}
                                      </li>
                                    ))}
                                  </ul>
                                )}
                                {edges.length > 0 && <small>依赖关系：{edges.length} 条</small>}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
            {execution.warnings.length > 0 && <p className="team-observation-warning">{execution.warnings.join("；")}</p>}
          </>
        );
      })()}
    </section>
  );
}
