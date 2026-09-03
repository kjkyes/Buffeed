import type { StreamEvent } from "./agent";
import type {
  TeamEdge,
  TeamMember,
  TeamObservation,
  TeamTask,
} from "@agentcore/contracts";

export type {
  TeamEdge,
  TeamMember,
  TeamObservation,
  TeamObservationEvent,
  TeamTask,
} from "@agentcore/contracts";

const RUN_EVENT_TYPES = new Set([
  "run.plan",
  "run.started",
  "run.progress",
  "run.completed",
  "run.failed",
]);

function asRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    : [];
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function structuralEdge(
  source: unknown,
  target: unknown,
  kind: unknown,
  label?: unknown,
): TeamEdge | null {
  const sourceId = text(source, "");
  const targetId = text(target, "");
  if (!sourceId || !targetId || sourceId === targetId) {
    return null;
  }
  return {
    source: sourceId,
    target: targetId,
    kind: text(kind, "dependency"),
    ...(typeof label === "string" && label.trim() ? { label: label.trim() } : {}),
  };
}

function appendEdge(edges: TeamEdge[], edge: TeamEdge | null): void {
  if (!edge) {
    return;
  }
  if (edges.some((item) => item.source === edge.source && item.target === edge.target && item.kind === edge.kind)) {
    return;
  }
  edges.push(edge);
}

/** Fold explicit Team events; ordinary Agent/tool events never create nodes. */
export function foldTeamEvent(
  current: TeamObservation | null,
  event: StreamEvent,
): TeamObservation | null {
  if (!RUN_EVENT_TYPES.has(event.type)) {
    return current;
  }
  const payload = event.payload;
  const executionId = text(payload.execution_id, "");
  if (!executionId) {
    return current;
  }
  const base = current && current.execution_id === executionId ? current : null;
  if (event.type !== "run.plan" && !base) {
    return current;
  }
  const numericCursor = Number(event.event_id);
  if (
    Number.isFinite(numericCursor)
    && base
    && numericCursor <= (base.event_cursor ?? 0)
  ) {
    return base;
  }
  const eventCursor = Number.isFinite(numericCursor)
    ? Math.max(base?.event_cursor ?? 0, numericCursor)
    : current?.event_cursor ?? 0;

  if (event.type === "run.plan") {
    const planMembers = asRecords(payload.members).map((member) => ({
      run_id: text(member.run_id, text(member.id, text(member.name, "member"))),
      name: text(member.name, text(member.run_id, "member")),
      role: text(member.role, "teammate"),
      status: text(member.status, "pending"),
      task_id: typeof member.task_id === "string" ? member.task_id : null,
      ...(typeof member.result === "string" ? { result: member.result } : {}),
    }));
    const memberMap = new Map(
      base?.source === "team_journal"
        ? base.members.map((member) => [member.run_id, member] as const)
        : [],
    );
    planMembers.forEach((member) => {
      const previous = memberMap.get(member.run_id);
      memberMap.set(
        member.run_id,
        previous && ["completed", "failed", "cancelled"].includes(previous.status)
          ? { ...previous, name: member.name, role: member.role, task_id: member.task_id ?? previous.task_id }
          : { ...previous, ...member },
      );
    });
    const planTasks = asRecords(payload.tasks).map((task) => ({
      task_id: text(task.task_id, text(task.id, "task")),
      subject: text(task.subject, text(task.task_id, "task")),
      description: text(task.description, ""),
      status: text(task.status, "pending"),
      owner: typeof task.owner === "string" ? task.owner : null,
      depends_on: Array.isArray(task.depends_on)
        ? task.depends_on.filter((value): value is string => typeof value === "string")
        : Array.isArray(task.blockedBy)
          ? task.blockedBy.filter((value): value is string => typeof value === "string")
        : [],
      worktree: typeof task.worktree === "string" ? task.worktree : null,
      assignee: typeof task.assignee === "string" ? task.assignee : null,
      assigned_run_id: typeof task.assigned_run_id === "string" ? task.assigned_run_id : null,
      takeover_allowed: task.takeover_allowed === true,
    }));
    const taskByOwner = new Map(
      planTasks
        .flatMap((task) => {
          const identities = [task.owner, task.assignee, task.assigned_run_id]
            .filter((identity): identity is string => typeof identity === "string" && identity.length > 0);
          return identities.map((identity) => [identity, task.task_id] as const);
        }),
    );
    const members = [...memberMap.values()].map((member) => ({
      ...member,
      task_id: member.task_id
        ?? taskByOwner.get(member.name)
        ?? taskByOwner.get(member.run_id)
        ?? null,
    }));
    const taskMap = new Map(
      base?.source === "team_journal"
        ? base.tasks.map((task) => [task.task_id, task] as const)
        : [],
    );
    planTasks.forEach((task) => {
      const previous = taskMap.get(task.task_id);
      taskMap.set(
        task.task_id,
        previous && ["completed", "failed", "cancelled"].includes(previous.status)
          ? { ...previous, subject: task.subject, description: task.description, owner: task.owner ?? previous.owner }
          : { ...previous, ...task },
      );
    });
    const tasks = [...taskMap.values()];
    const edgeMap = new Map(
      base?.source === "team_journal"
        ? base.edges.map((edge) => [`${edge.source}:${edge.target}:${edge.kind}`, edge] as const)
        : [],
    );
    asRecords(payload.edges).map((edge) => ({
      source: text(edge.source, ""),
      target: text(edge.target, ""),
      kind: text(edge.kind, "depends_on"),
      ...(typeof edge.label === "string" && edge.label.trim() ? { label: edge.label.trim() } : {}),
    })).filter((edge) => edge.source && edge.target).forEach((edge) => {
      edgeMap.set(`${edge.source}:${edge.target}:${edge.kind}`, edge);
    });
    const edges = [...edgeMap.values()];
    return {
      schema_version: 2,
      read_only: true,
      source: "team_journal",
      available: Boolean(members.length || tasks.length),
      has_team: members.length > 0,
      plan_seen: true,
      execution_id: executionId,
      turn_id: base?.turn_id ?? event.turnId,
      members,
      tasks,
      edges,
      warnings: [],
      event_cursor: eventCursor,
      updated_at: event.createdAt ?? Date.now() / 1000,
    };
  }

  if (!base || base.source !== "team_journal") {
    return current;
  }
  const runId = text(payload.run_id, "");
  if (!runId) {
    return current;
  }
  const knownMember = base.members.some((member) => member.run_id === runId);
  let members = [
    ...(knownMember
      ? []
      : [{
        run_id: runId,
        name: text(payload.name, runId),
        role: text(payload.role, "teammate"),
        status: "pending",
        task_id: typeof payload.task_id === "string" ? payload.task_id : null,
      }]),
    ...base.members,
  ].map((member) => {
    if (member.run_id !== runId) {
      return member;
    }
    const next = { ...member };
    if (typeof payload.name === "string") next.name = payload.name;
    if (typeof payload.role === "string") next.role = payload.role;
    if (typeof payload.task_id === "string") next.task_id = payload.task_id;
    if (event.type === "run.started") next.status = "running";
    if (event.type === "run.progress") {
      next.status = payload.phase === "cancel.reported" || payload.status === "cancelled"
        ? "cancelled"
        : "working";
      next.phase = text(payload.phase, "working");
      if (typeof payload.tool_name === "string") next.tool_name = payload.tool_name;
      if (typeof payload.in_flight === "boolean") next.in_flight = payload.in_flight;
      next.summary = text(payload.summary, "");
    }
    if (event.type === "run.completed") {
      next.status = "completed";
      if (typeof payload.duration_ms === "number") next.duration_ms = payload.duration_ms;
      if (typeof payload.result === "string") next.result = payload.result;
    }
    if (event.type === "run.failed") {
      next.error_code = text(payload.error_code, "unknown");
      next.status = next.error_code === "cancelled" ? "cancelled" : "failed";
      next.error = text(payload.message, "");
    }
    return next;
  });
  const ensureStructuralMember = (runId: unknown) => {
    const id = text(runId, "");
    if (!id || members.some((member) => member.run_id === id)) {
      return;
    }
    members = [
      {
        run_id: id,
        name: id,
        role: "teammate",
        status: "completed",
        task_id: null,
      },
      ...members,
    ];
  };
  ensureStructuralMember(payload.parent_run_id);
  ensureStructuralMember(payload.continues_run_id);
  const memberForRun = base.members.find((member) => member.run_id === runId);
  const taskId = typeof payload.task_id === "string"
    ? payload.task_id
    : memberForRun?.task_id
      ?? base.tasks.find((task) => (
        task.owner === runId
        || task.owner === memberForRun?.name
        || task.assigned_run_id === runId
        || task.assignee === memberForRun?.name
      ))?.task_id
      ?? null;
  let tasks = base.tasks;
  if (taskId && event.type === "run.progress" && payload.phase === "task.completed") {
    tasks = base.tasks.map((task) => task.task_id === taskId
      ? { ...task, status: "completed" }
      : task);
  } else if (taskId && ["run.completed", "run.failed"].includes(event.type)) {
    tasks = base.tasks.map((task) => task.task_id === taskId
      ? {
        ...task,
        status: event.type === "run.completed"
          ? "completed"
          : String(payload.error_code ?? "") === "cancelled"
            ? "cancelled"
            : "failed",
      }
      : task);
  }
  const lead = members.find((member) => member.run_id === "lead");
  if (lead && ["completed", "failed"].includes(lead.status)) {
    const pendingMemberIds = new Set(
      members
        .filter((member) => member.run_id !== "lead" && !["completed", "failed", "cancelled"].includes(member.status))
        .map((member) => member.run_id),
    );
    members = members.map((member) => pendingMemberIds.has(member.run_id)
      ? {
        ...member,
        status: "cancelled",
        error_code: "lead_finished",
        error: "Lead turn finished; teammate terminal event is pending.",
      }
      : member);
    const memberByIdentity = new Map(
      members.flatMap((member) => [
        [member.run_id, member] as const,
        [member.name, member] as const,
      ]),
    );
    tasks = tasks.map((task) => {
      if (["completed", "failed", "cancelled"].includes(task.status)) {
        return task;
      }
      const owner = task.owner || "lead";
      const ownerMember = memberByIdentity.get(owner === "agent" ? "lead" : owner);
      if (ownerMember?.status === "completed") {
        return { ...task, status: "completed" };
      }
      if (ownerMember?.status === "failed") {
        return { ...task, status: "failed" };
      }
      return { ...task, status: "cancelled" };
    });
  }
  const edges = [...base.edges];
  appendEdge(
    edges,
    structuralEdge(
      payload.parent_run_id,
      runId,
      payload.edge_kind ?? "delegate",
    ),
  );
  appendEdge(
    edges,
    structuralEdge(payload.continues_run_id, runId, "continuation"),
  );
  if (payload.edge && typeof payload.edge === "object" && !Array.isArray(payload.edge)) {
    const rawEdge = payload.edge as Record<string, unknown>;
    appendEdge(edges, structuralEdge(rawEdge.source, rawEdge.target, rawEdge.kind, rawEdge.label));
  }
  return {
    ...base,
    members,
    tasks,
    edges,
    event_cursor: eventCursor,
    updated_at: event.createdAt ?? base.updated_at,
    turn_id: base.turn_id ?? event.turnId,
  };
}
