"""Read-only Team observation projections used by the Agent API."""

from __future__ import annotations

from dataclasses import asdict, is_dataclass
from time import time
from typing import Any, Iterable

from team_events import fold_team_events


def _clip(value: Any, limit: int = 2_000) -> str:
    text = str(value or "")
    return text if len(text) <= limit else f"{text[:limit]}\n..."


def _task_record(task: Any) -> dict[str, Any]:
    if is_dataclass(task):
        raw = asdict(task)
    elif isinstance(task, dict):
        raw = dict(task)
    else:
        raw = {
            name: getattr(task, name, None)
            for name in ("id", "subject", "description", "status", "owner", "blockedBy", "worktree")
        }
    blocked_by = raw.get("blockedBy", raw.get("blocked_by", []))
    if not isinstance(blocked_by, (list, tuple)):
        blocked_by = []
    raw_task_id = raw.get("id")
    task_id = str(raw_task_id).strip() if raw_task_id else ""
    return {
        "task_id": task_id,
        "subject": _clip(raw.get("subject", task_id), 500),
        "description": _clip(raw.get("description", "")),
        "status": str(raw.get("status", "unknown")),
        "owner": str(raw["owner"]) if raw.get("owner") else None,
        "depends_on": [str(value) for value in blocked_by if value],
        "worktree": str(raw["worktree"]) if raw.get("worktree") else None,
    }


def _active_names(buffeed: Any) -> list[str]:
    active = getattr(buffeed, "active_teammates", {})
    if isinstance(active, dict):
        try:
            snapshot = list(active.items())
        except RuntimeError:
            return []
        return sorted(str(name) for name, enabled in snapshot if enabled)
    if isinstance(active, (list, tuple, set)):
        return sorted(str(name) for name in active)
    return []


def build_legacy_team_snapshot(
    buffeed: Any,
    *,
    execution_id: str,
    active_turn_id: str | None = None,
) -> dict[str, Any]:
    """Project the existing task files for compatibility before a plan exists."""
    warnings: list[str] = []
    try:
        raw_tasks = buffeed.list_tasks()
    except Exception as exc:
        raw_tasks = []
        warnings.append(f"task_snapshot_failed:{type(exc).__name__}")

    tasks: list[dict[str, Any]] = []
    for index, raw_task in enumerate(raw_tasks or []):
        try:
            task = _task_record(raw_task)
        except Exception as exc:
            warnings.append(f"task_record_failed:{index}:{type(exc).__name__}")
            continue
        if task["task_id"]:
            tasks.append(task)

    active_names = _active_names(buffeed)
    owners = {
        task["owner"]
        for task in tasks
        if task["owner"] and task["owner"] not in {"agent", "lead"}
    }
    lead_has_state = bool(active_turn_id) or any(
        task["owner"] in {"agent", "lead"} for task in tasks
    )

    members: list[dict[str, Any]] = []
    if lead_has_state:
        members.append(
            {
                "run_id": "lead",
                "name": "lead",
                "role": "lead",
                "status": "running" if active_turn_id else (
                    "working"
                    if any(
                        task["owner"] in {"agent", "lead"}
                        and task["status"] == "in_progress"
                        for task in tasks
                    )
                    else "idle"
                ),
                "task_id": next(
                    (
                        task["task_id"]
                        for task in tasks
                        if task["owner"] in {"agent", "lead"}
                    ),
                    None,
                ),
            }
        )
    members.extend(
        {
            "run_id": f"member:{name}",
            "name": name,
            "role": "teammate",
            "status": "running",
            "task_id": next(
                (task["task_id"] for task in tasks if task["owner"] == name),
                None,
            ),
        }
        for name in active_names
    )
    members.extend(
        {
            "run_id": f"owner:{owner}",
            "name": owner,
            "role": "task owner",
            "status": "working" if any(
                task["owner"] == owner and task["status"] == "in_progress"
                for task in tasks
            ) else "idle",
            "task_id": next(
                (task["task_id"] for task in tasks if task["owner"] == owner),
                None,
            ),
        }
        for owner in sorted(owners)
        if owner not in active_names
    )

    task_ids = {task["task_id"] for task in tasks}
    edges = [
        {
            "source": dependency,
            "target": task["task_id"],
            "kind": "depends_on",
        }
        for task in tasks
        for dependency in task["depends_on"]
        if dependency in task_ids
    ]
    return {
        "schema_version": 1,
        "read_only": True,
        "source": "legacy_task_snapshot",
        "available": bool(tasks or active_names),
        "has_team": bool(active_names),
        "execution_id": execution_id,
        "turn_id": active_turn_id,
        "members": members,
        "tasks": tasks,
        "edges": edges,
        "warnings": warnings,
        "event_cursor": 0,
        "updated_at": time(),
    }


def build_team_snapshot(
    buffeed: Any,
    *,
    execution_id: str,
    active_turn_id: str | None = None,
    team_events: Iterable[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Project durable Team events without inventing nodes from task files.

    ``team_events`` is deliberately tri-state: the API passes an iterable (also
    an empty list) when it has inspected the durable journal, while ``None`` is
    reserved for older callers that explicitly need the compatibility snapshot.
    """
    if team_events is not None:
        snapshot = fold_team_events(team_events, execution_id=execution_id)
        if active_turn_id:
            snapshot["turn_id"] = active_turn_id
        # An explicit (even temporarily empty) journal is authoritative.
        # Falling back here would invent members/tasks for a normal Agent turn.
        return snapshot
    return build_legacy_team_snapshot(
        buffeed,
        execution_id=execution_id,
        active_turn_id=active_turn_id,
    )
