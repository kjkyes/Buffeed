"""Durable Team event contract, journal adapter, and pure projection.

The journal deliberately uses the Agent API's durable event store through a
small callable boundary.  This keeps one cursor namespace per session while
allowing the Buffeed runtime to emit structural events without depending on the
desktop API implementation details.
"""

from __future__ import annotations

from dataclasses import dataclass
from time import time
from typing import Any, Callable, Iterable


TEAM_EVENT_TYPES = frozenset(
    {
        "run.plan",
        "run.started",
        "run.progress",
        "run.completed",
        "run.failed",
    }
)

TEAM_EDGE_KINDS = frozenset(
    {
        "owner",
        "dependency",
        "depends_on",
        "delegate",
        "continuation",
        "execution-flow",
    }
)


@dataclass(frozen=True)
class TeamEvent:
    event_type: str
    execution_id: str
    run_id: str | None
    payload: dict[str, Any]


def _text(value: Any, limit: int = 2_000) -> str:
    text = str(value or "")
    return text if len(text) <= limit else f"{text[:limit]}\n..."


def _list_of_dicts(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [dict(item) for item in value if isinstance(item, dict)]


def _edge_record(raw: dict[str, Any]) -> dict[str, Any] | None:
    source = str(raw.get("source") or "").strip()
    target = str(raw.get("target") or "").strip()
    if not source or not target or source == target:
        return None
    kind = str(raw.get("kind") or "dependency").strip()
    if not kind:
        kind = "dependency"
    edge = {"source": source, "target": target, "kind": kind}
    if raw.get("label"):
        edge["label"] = _text(raw["label"], 160)
    return edge


def _append_edge(edges: list[dict[str, Any]], edge: dict[str, Any] | None) -> None:
    if edge is None:
        return
    identity = (edge["source"], edge["target"], edge["kind"])
    if any(
        (item.get("source"), item.get("target"), item.get("kind")) == identity
        for item in edges
    ):
        return
    edges.append(edge)


def normalize_team_event(
    event_type: str,
    payload: dict[str, Any] | None,
    *,
    execution_id: str,
) -> TeamEvent:
    """Validate and enrich a structural event before it reaches storage."""
    if event_type not in TEAM_EVENT_TYPES:
        raise ValueError(f"unsupported Team event type: {event_type}")
    if not execution_id.strip():
        raise ValueError("execution_id cannot be empty")
    data = dict(payload or {})
    data["execution_id"] = execution_id
    run_id = data.get("run_id")
    if event_type != "run.plan" and not str(run_id or "").strip():
        raise ValueError(f"{event_type} requires run_id")
    if event_type == "run.plan":
        data["members"] = _list_of_dicts(data.get("members"))
        data["tasks"] = _list_of_dicts(data.get("tasks"))
        data["edges"] = _list_of_dicts(data.get("edges"))
    else:
        if data.get("edge"):
            data["edge"] = dict(data["edge"]) if isinstance(data["edge"], dict) else None
        if event_type == "run.progress":
            data["phase"] = _text(data.get("phase", "working"), 120)
            if data.get("tool_name"):
                data["tool_name"] = _text(data.get("tool_name"), 120)
            data["summary"] = _text(data.get("summary", ""))
        elif event_type == "run.completed":
            if data.get("result") is not None:
                data["result"] = _text(data.get("result"), 50_000)
            if data.get("result_format"):
                data["result_format"] = _text(data.get("result_format"), 80)
        elif event_type == "run.failed":
            data["error_code"] = _text(data.get("error_code", "unknown"), 120)
            data["message"] = _text(data.get("message", ""))
    return TeamEvent(
        event_type=event_type,
        execution_id=execution_id,
        run_id=str(run_id) if run_id else None,
        payload=data,
    )


class TeamEventJournal:
    """Append/replay adapter over a durable session event store."""

    def __init__(
        self,
        *,
        execution_id: str,
        publish: Callable[[str, dict[str, Any], str | None], dict[str, Any]],
        replay: Callable[[int], list[dict[str, Any]]],
    ) -> None:
        self.execution_id = execution_id
        self._publish = publish
        self._replay = replay

    def append(
        self,
        event_type: str,
        payload: dict[str, Any] | None = None,
        *,
        turn_id: str | None = None,
        execution_id: str | None = None,
    ) -> dict[str, Any]:
        effective_execution_id = (execution_id or self.execution_id).strip()
        event = normalize_team_event(
            event_type,
            payload,
            execution_id=effective_execution_id,
        )
        return self._publish(event.event_type, event.payload, turn_id)

    @staticmethod
    def _team_events(events: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
        return [
            event
            for event in events
            if isinstance(event, dict) and event.get("event_type") in TEAM_EVENT_TYPES
        ]

    def replay(
        self,
        *,
        after: int = 0,
        execution_id: str | None = None,
    ) -> list[dict[str, Any]]:
        expected_execution_id = (execution_id or self.execution_id).strip()
        return [
            event
            for event in self._team_events(self._replay(after))
            if isinstance(event.get("payload"), dict)
            and event["payload"].get("execution_id") == expected_execution_id
        ]

    def replay_all(self, *, after: int = 0) -> list[dict[str, Any]]:
        """Return structural events without assuming one execution id."""
        return self._team_events(self._replay(after))

    def snapshot(self, *, after: int = 0) -> dict[str, Any]:
        return fold_team_events(self.replay(after=after), execution_id=self.execution_id)


def _member_record(raw: dict[str, Any]) -> dict[str, Any] | None:
    run_id = str(raw.get("run_id") or raw.get("id") or "").strip()
    name = str(raw.get("name") or run_id).strip()
    if not run_id or not name:
        return None
    return {
        "run_id": run_id,
        "name": name,
        "role": str(raw.get("role") or "teammate"),
        "status": str(raw.get("status") or "pending"),
        "task_id": str(raw["task_id"]) if raw.get("task_id") else None,
        "result": _text(raw.get("result")),
        "result_format": _text(raw.get("result_format"), 80),
    }


def _task_record(raw: dict[str, Any]) -> dict[str, Any] | None:
    task_id = str(raw.get("task_id") or raw.get("id") or "").strip()
    if not task_id:
        return None
    depends_on = raw.get("depends_on", raw.get("blockedBy", []))
    if not isinstance(depends_on, list):
        depends_on = []
    return {
        "task_id": task_id,
        "subject": _text(raw.get("subject") or task_id, 500),
        "description": _text(raw.get("description")),
        "status": str(raw.get("status") or "pending"),
        "owner": str(raw["owner"]) if raw.get("owner") else None,
        "depends_on": [str(value) for value in depends_on if value],
        "worktree": str(raw["worktree"]) if raw.get("worktree") else None,
        "assignee": str(raw["assignee"]) if raw.get("assignee") else None,
        "assigned_run_id": str(raw["assigned_run_id"]) if raw.get("assigned_run_id") else None,
        "takeover_allowed": bool(raw.get("takeover_allowed", False)),
    }


def fold_team_events(
    events: Iterable[dict[str, Any]],
    *,
    execution_id: str,
) -> dict[str, Any]:
    """Fold only explicit Team events into the renderer's observation shape."""
    members: dict[str, dict[str, Any]] = {}
    tasks: dict[str, dict[str, Any]] = {}
    edges: list[dict[str, Any]] = []
    warnings: list[str] = []
    plan_seen = False
    cursor = 0
    updated_at: float | None = None
    turn_id: str | None = None

    for event in events:
        if not isinstance(event, dict):
            warnings.append("invalid_event")
            continue
        event_type = str(event.get("event_type") or "")
        if event_type not in TEAM_EVENT_TYPES:
            continue
        payload = event.get("payload")
        if not isinstance(payload, dict):
            warnings.append(f"invalid_payload:{event_type}")
            continue
        if payload.get("execution_id") != execution_id:
            warnings.append(f"execution_mismatch:{event_type}")
            continue
        try:
            cursor = max(cursor, int(event.get("event_id") or 0))
        except (TypeError, ValueError):
            pass
        if isinstance(event.get("created_at"), (int, float)):
            updated_at = max(updated_at or 0, float(event["created_at"]))
        if event.get("turn_id"):
            turn_id = str(event["turn_id"])

        if event_type == "run.plan":
            plan_seen = True
            for raw_member in _list_of_dicts(payload.get("members")):
                member = _member_record(raw_member)
                if member:
                    previous = members.get(member["run_id"])
                    if previous is None:
                        members[member["run_id"]] = member
                    else:
                        previous.update(
                            {
                                key: value
                                for key, value in member.items()
                                if key != "status" or previous.get("status") not in {"completed", "failed", "cancelled"}
                            }
                        )
            for raw_task in _list_of_dicts(payload.get("tasks")):
                task = _task_record(raw_task)
                if task:
                    previous = tasks.get(task["task_id"])
                    if previous is None:
                        tasks[task["task_id"]] = task
                    else:
                        previous.update(
                            {
                                key: value
                                for key, value in task.items()
                                if key != "status" or previous.get("status") not in {"completed", "failed", "cancelled"}
                            }
                        )
            task_by_owner = {
                task["owner"]: task["task_id"]
                for task in tasks.values()
                if task.get("owner")
            }
            for member in members.values():
                if member.get("task_id"):
                    continue
                inferred_task_id = task_by_owner.get(member.get("name"))
                if inferred_task_id is None:
                    inferred_task_id = task_by_owner.get(member.get("run_id"))
                if inferred_task_id is not None:
                    member["task_id"] = inferred_task_id
            known_edges = {
                (edge["source"], edge["target"], edge["kind"]): edge
                for edge in edges
            }
            for raw_edge in _list_of_dicts(payload.get("edges")):
                edge = _edge_record(raw_edge)
                if edge:
                    known_edges[(edge["source"], edge["target"], edge["kind"])] = edge
            edges = list(known_edges.values())
            continue

        run_id = str(payload.get("run_id") or "").strip()
        if not run_id:
            warnings.append(f"missing_run_id:{event_type}")
            continue
        member = members.setdefault(
            run_id,
            {
                "run_id": run_id,
                "name": str(payload.get("name") or run_id),
                "role": str(payload.get("role") or "teammate"),
                "status": "pending",
                "task_id": None,
            },
        )
        if payload.get("name"):
            member["name"] = str(payload["name"])
        if payload.get("role"):
            member["role"] = str(payload["role"])
        if payload.get("task_id"):
            member["task_id"] = str(payload["task_id"])

        if event_type == "run.started":
            member["status"] = "running"
        elif event_type == "run.progress":
            phase = _text(payload.get("phase"), 120)
            member["status"] = (
                "cancelled"
                if phase == "cancel.reported" or payload.get("status") == "cancelled"
                else "working"
            )
            member["phase"] = phase
            if payload.get("tool_name"):
                member["tool_name"] = _text(payload.get("tool_name"), 120)
            member["summary"] = _text(payload.get("summary"))
        elif event_type == "run.completed":
            member["status"] = "completed"
            if payload.get("duration_ms") is not None:
                member["duration_ms"] = payload["duration_ms"]
            if payload.get("result"):
                member["result"] = _text(payload.get("result"))
            if payload.get("result_format"):
                member["result_format"] = _text(payload.get("result_format"), 80)
        elif event_type == "run.failed":
            error_code = _text(payload.get("error_code"), 120)
            member["status"] = "cancelled" if error_code == "cancelled" else "failed"
            member["error_code"] = error_code
            member["error"] = _text(payload.get("message"))

        task_id = member.get("task_id")
        if not task_id:
            task_id = next(
                (
                    candidate["task_id"]
                    for candidate in tasks.values()
                    if (
                        candidate.get("owner") in {member.get("name"), member.get("run_id")}
                        or candidate.get("assignee") == member.get("name")
                        or candidate.get("assigned_run_id") == member.get("run_id")
                    )
                ),
                None,
            )
            if task_id:
                member["task_id"] = task_id
        if task_id in tasks and event_type == "run.progress" and payload.get("phase") == "task.completed":
            tasks[task_id]["status"] = "completed"
        if task_id in tasks and event_type in {"run.completed", "run.failed"}:
            tasks[task_id]["status"] = (
                "completed"
                if event_type == "run.completed"
                else "cancelled"
                if str(payload.get("error_code") or "") == "cancelled"
                else "failed"
            )

        # Structural links are opt-in.  A lifecycle event may explicitly carry
        # a parent/continuation run or an edge record; ordinary progress does
        # not create graph relationships by itself.
        parent_run_id = str(payload.get("parent_run_id") or "").strip()
        if parent_run_id:
            members.setdefault(
                parent_run_id,
                {
                    "run_id": parent_run_id,
                    "name": parent_run_id,
                    "role": "teammate",
                    "status": "completed",
                    "task_id": None,
                },
            )
            _append_edge(
                edges,
                _edge_record(
                    {
                        "source": parent_run_id,
                        "target": run_id,
                        "kind": payload.get("edge_kind") or "delegate",
                    }
                ),
            )
        continues_run_id = str(payload.get("continues_run_id") or "").strip()
        if continues_run_id:
            members.setdefault(
                continues_run_id,
                {
                    "run_id": continues_run_id,
                    "name": continues_run_id,
                    "role": "teammate",
                    "status": "completed",
                    "task_id": None,
                },
            )
            _append_edge(
                edges,
                _edge_record(
                    {
                        "source": continues_run_id,
                        "target": run_id,
                        "kind": "continuation",
                    }
                ),
            )
        raw_event_edge = payload.get("edge")
        if isinstance(raw_event_edge, dict):
            _append_edge(edges, _edge_record(raw_event_edge))

    lead = members.get("lead")
    if lead and lead.get("status") in {"completed", "failed"}:
        # The desktop runtime cancels active teammates immediately after the
        # lead turn reaches a terminal state. Their own terminal events may
        # arrive slightly later, so project the explicit lead boundary without
        # waiting for another model/tool round. A later run.* event can still
        # replace this provisional state with its real terminal state.
        pending_member_ids: set[str] = set()
        for member_id, member in members.items():
            if member_id == "lead" or member.get("status") in {"completed", "failed", "cancelled"}:
                continue
            pending_member_ids.add(member_id)
        for member_id in pending_member_ids:
            member = members[member_id]
            member["status"] = "cancelled"
            member["error_code"] = "lead_finished"
            member["error"] = "Lead turn finished; teammate terminal event is pending."

        member_by_identity = {
            identity: member
            for member in members.values()
            for identity in (member.get("run_id"), member.get("name"))
            if identity
        }
        for task_id, task in tasks.items():
            if task.get("status") in {"completed", "failed", "cancelled"}:
                continue
            owner = str(task.get("owner") or "lead")
            owner_member = member_by_identity.get("lead" if owner == "agent" else owner)
            if owner_member and owner_member.get("status") == "completed":
                task["status"] = "completed"
            elif owner_member and owner_member.get("status") == "failed":
                task["status"] = "failed"
            else:
                task["status"] = "cancelled"

    node_ids = set(tasks) | set(members)
    valid_edges = [
        edge
        for edge in edges
        if edge["source"] in node_ids and edge["target"] in node_ids
    ]
    return {
        "schema_version": 2,
        "read_only": True,
        "source": "team_journal",
        "available": bool(plan_seen and (members or tasks)),
        "has_team": bool(plan_seen and members),
        "plan_seen": plan_seen,
        "execution_id": execution_id,
        "turn_id": turn_id,
        "members": list(members.values()),
        "tasks": list(tasks.values()),
        "edges": valid_edges,
        "warnings": warnings,
        "event_cursor": cursor,
        "updated_at": updated_at or time(),
    }
