export const TEAM_EVENT_TYPES = [
  "run.plan",
  "run.started",
  "run.progress",
  "run.completed",
  "run.failed",
] as const;

export const TEAM_EDGE_KINDS = [
  "owner",
  "dependency",
  "depends_on",
  "delegate",
  "continuation",
  "execution-flow",
] as const;

export type TeamEdgeKind = (typeof TEAM_EDGE_KINDS)[number];

export type TeamEventType = (typeof TEAM_EVENT_TYPES)[number];

export type TeamMember = {
  run_id: string;
  name: string;
  role: string;
  status: string;
  task_id: string | null;
  phase?: string;
  tool_name?: string;
  in_flight?: boolean;
  summary?: string;
  result?: string;
  result_format?: string;
  duration_ms?: number;
  error_code?: string;
  error?: string;
};

export type TeamTask = {
  task_id: string;
  subject: string;
  description: string;
  status: string;
  owner: string | null;
  depends_on: string[];
  worktree: string | null;
  assignee?: string | null;
  assigned_run_id?: string | null;
  takeover_allowed?: boolean;
};

export type TeamPlanMember = {
  run_id?: string;
  id?: string;
  name?: string;
  role?: string;
  status?: string;
  task_id?: string | null;
  [key: string]: unknown;
};

export type TeamPlanTask = {
  task_id?: string;
  id?: string;
  subject?: string;
  description?: string;
  status?: string;
  owner?: string | null;
  depends_on?: string[];
  blockedBy?: string[];
  worktree?: string | null;
  assignee?: string | null;
  assigned_run_id?: string | null;
  takeover_allowed?: boolean;
  [key: string]: unknown;
};

export type TeamEdge = {
  source: string;
  target: string;
  /** Known structural kinds are listed above; unknown kinds remain replay-compatible. */
  kind: TeamEdgeKind | (string & {});
  label?: string;
};

export type TeamObservationSource = "team_journal" | "legacy_task_snapshot" | string;

export type TeamObservation = {
  schema_version: number;
  read_only: boolean;
  available: boolean;
  has_team: boolean;
  plan_seen?: boolean;
  execution_id: string;
  turn_id: string | null;
  members: TeamMember[];
  tasks: TeamTask[];
  edges: TeamEdge[];
  warnings: string[];
  updated_at: number;
  source?: TeamObservationSource;
  event_cursor?: number;
  events?: TeamObservationEvent[];
};

export type TeamObservationEvent = {
  event_id: number;
  event_type: TeamEventType | string;
  turn_id: string | null;
  payload: TeamEventPayload;
  created_at: number;
};

export type TeamEventPayload = {
  execution_id?: string;
  run_id?: string;
  name?: string;
  role?: string;
  task_id?: string;
  phase?: string;
  tool_name?: string;
  status?: string;
  partial?: boolean;
  in_flight?: boolean;
  summary?: string;
  duration_ms?: number;
  error_code?: string;
  message?: string;
  result?: string;
  result_format?: string;
  parent_run_id?: string;
  continues_run_id?: string;
  edge_kind?: TeamEdgeKind | string;
  edge?: Record<string, unknown>;
  members?: TeamPlanMember[];
  tasks?: TeamPlanTask[];
  edges?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

export type PersistedTeamEvent = {
  event_id: number;
  event_type: TeamEventType | string;
  turn_id: string | null;
  payload: TeamEventPayload;
  created_at: number;
};
