"""Durable storage primitives for the Agent API.

The SQLite event table is the append-only journal for both ordinary Agent
events and structural Team ``run.*`` events.  Keeping the storage adapter in
``apps/agent-runtime`` makes the root entry point the next source of truth
without changing the legacy API import surface yet.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


MAX_HISTORY_CACHE_SESSIONS = 8
EVENT_SUMMARY_PREVIEW_CHARS = 800
EVENT_SUMMARY_INPUT_CHARS = 1_200


def _now() -> float:
    return time.time()


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=str, separators=(",", ":"))


def _parse_json_list(value: Any) -> list[dict[str, Any]]:
    try:
        parsed = json.loads(str(value or "[]"))
    except (TypeError, ValueError):
        return []
    return [item for item in parsed if isinstance(item, dict)] if isinstance(parsed, list) else []


def _clip_event_text(value: Any, limit: int) -> str:
    text = str(value or "")
    if len(text) <= limit:
        return text
    return f"{text[:limit]}\n... (details available)"


def _summary_input(value: Any) -> Any:
    if not isinstance(value, dict):
        return _clip_event_text(value, EVENT_SUMMARY_INPUT_CHARS)
    summary: dict[str, Any] = {}
    for key, item in value.items():
        normalized = str(key).lower()
        if any(secret in normalized for secret in ("token", "secret", "password", "api_key")):
            summary[str(key)] = "[redacted]"
            continue
        if normalized == "todos" and isinstance(item, list):
            summary[str(key)] = [
                {
                    field: _clip_event_text(todo.get(field), 240)
                    if field == "content"
                    else todo.get(field)
                    for field in ("id", "content", "status")
                    if field in todo
                }
                for todo in item
                if isinstance(todo, dict)
            ]
            continue
        if isinstance(item, str):
            summary[str(key)] = _clip_event_text(item, 480)
            continue
        if isinstance(item, (int, float, bool)) or item is None:
            summary[str(key)] = item
            continue
        summary[str(key)] = _clip_event_text(_json(item), 480)
    return summary


def _summary_event(event: dict[str, Any]) -> dict[str, Any]:
    event_type = str(event.get("event_type") or "")
    if event_type not in {"tool.requested", "tool.result"}:
        return event
    payload = dict(event.get("payload") or {})
    if event_type == "tool.requested":
        payload["input"] = _summary_input(payload.get("input"))
    else:
        payload["output"] = _clip_event_text(
            payload.get("output"), EVENT_SUMMARY_PREVIEW_CHARS
        )
    payload["_summary"] = True
    payload["_detail_event_id"] = int(event["event_id"])
    payload["_detail_available"] = True
    return {**event, "payload": payload}


def compact_session_title(query: str, max_chars: int = 20) -> str:
    """Use the first prompt as a deterministic title without another model request."""
    text = " ".join(str(query or "").split()).strip()
    if not text:
        return "新会话"
    return f"{text[:max_chars]}..." if len(text) > max_chars else text


def _fold_history_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Fold low-value lifecycle events without changing the durable journal."""
    lifecycle_counts: dict[str, dict[str, int]] = {}
    for event in events:
        turn_id = str(event.get("turn_id") or "")
        if not turn_id:
            continue
        counts = lifecycle_counts.setdefault(
            turn_id,
            {"model_requests": 0, "replies": 0},
        )
        if event["event_type"] == "model.requested":
            counts["model_requests"] += 1
        elif (
            event["event_type"] == "assistant.message"
            and str((event.get("payload") or {}).get("phase") or "final") == "final"
        ):
            counts["replies"] += 1

    compacted: list[dict[str, Any]] = []
    for event in events:
        event_type = event["event_type"]
        if event_type in {"model.requested", "turn.completed"}:
            continue
        if event_type == "turn.finished":
            turn_id = str(event.get("turn_id") or "")
            payload = dict(event.get("payload") or {})
            payload["lifecycle_summary"] = lifecycle_counts.get(
                turn_id,
                {"model_requests": 0, "replies": 0},
            )
            event = {**event, "payload": payload}
        compacted.append(event)
    return compacted


class DesktopStore:
    """Small SQLite adapter shared by the Agent REST API and event journal."""

    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path
        self._lock = threading.Lock()
        self._history_cache: dict[str, list[dict[str, Any]]] = {}
        self._history_cache_access: dict[str, float] = {}
        self._history_generation: dict[str, int] = {}

    def initialize(self) -> None:
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connection() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute("PRAGMA synchronous = FULL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS sessions (
                    session_id TEXT PRIMARY KEY,
                    workspace TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    title TEXT NOT NULL DEFAULT ''
                );
                CREATE TABLE IF NOT EXISTS turns (
                    turn_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    query TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    finished_at REAL,
                    attachments TEXT NOT NULL DEFAULT '[]',
                    model TEXT NOT NULL DEFAULT 'system'
                );
                CREATE TABLE IF NOT EXISTS events (
                    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    turn_id TEXT,
                    event_type TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    created_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_events_session_cursor
                    ON events (session_id, event_id);
                CREATE TABLE IF NOT EXISTS approvals (
                    approval_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    turn_id TEXT NOT NULL,
                    tool_name TEXT NOT NULL,
                    tool_input TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    resolved_at REAL
                );
                """
            )
            columns = {
                str(row[1])
                for row in connection.execute("PRAGMA table_info(sessions)").fetchall()
            }
            if "title" not in columns:
                connection.execute(
                    "ALTER TABLE sessions ADD COLUMN title TEXT NOT NULL DEFAULT ''"
                )
            turn_columns = {
                str(row[1])
                for row in connection.execute("PRAGMA table_info(turns)").fetchall()
            }
            if "attachments" not in turn_columns:
                connection.execute(
                    "ALTER TABLE turns ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'"
                )
            if "model" not in turn_columns:
                connection.execute(
                    "ALTER TABLE turns ADD COLUMN model TEXT NOT NULL DEFAULT 'system'"
                )

    def recover_orphaned_turns(self) -> int:
        """Mark turns left running by a previous process as interrupted."""
        now = _now()
        recovered = 0
        with self._lock, self._connection() as connection:
            rows = connection.execute(
                "SELECT turn_id, session_id FROM turns WHERE status = ?",
                ("running",),
            ).fetchall()
            for row in rows:
                turn_id = str(row["turn_id"])
                session_id = str(row["session_id"])
                connection.execute(
                    "UPDATE turns SET status = ?, finished_at = ? WHERE turn_id = ? AND status = ?",
                    ("error", now, turn_id, "running"),
                )
                connection.execute(
                    "INSERT INTO events (session_id, turn_id, event_type, payload, created_at) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (
                        session_id,
                        turn_id,
                        "turn.error",
                        _json({
                            "error_type": "RuntimeRestarted",
                            "message": "Desktop/Agent 重启时检测到该回合没有活动执行线程，已中断。",
                            "recovered": True,
                        }),
                        now,
                    ),
                )
                recovered += 1

            if rows:
                session_ids = {str(row["session_id"]) for row in rows}
                for session_id in session_ids:
                    has_queued = connection.execute(
                        "SELECT 1 FROM turns WHERE session_id = ? AND status = ? LIMIT 1",
                        (session_id, "queued"),
                    ).fetchone()
                    connection.execute(
                        "UPDATE sessions SET status = ?, updated_at = ? WHERE session_id = ?",
                        ("running" if has_queued else "idle", now, session_id),
                    )
                self._history_cache.clear()
                self._history_cache_access.clear()
                self._history_generation.clear()
        return recovered

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 5000")
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        connection = self._connect()
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def create_session(self, session_id: str, workspace: Path) -> None:
        now = _now()
        with self._lock, self._connection() as connection:
            connection.execute(
                "INSERT INTO sessions (session_id, workspace, status, created_at, updated_at, title) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (session_id, str(workspace), "idle", now, now, ""),
            )

    def fork_session(
        self,
        source_session_id: str,
        turn_id: str,
        new_session_id: str,
    ) -> dict[str, Any]:
        """Clone conversation history through one turn into a fresh idle session."""
        now = _now()
        with self._lock, self._connection() as connection:
            source = connection.execute(
                "SELECT workspace, title FROM sessions WHERE session_id = ?",
                (source_session_id,),
            ).fetchone()
            if source is None:
                raise KeyError(source_session_id)
            selected = connection.execute(
                "SELECT turn_id, created_at FROM turns "
                "WHERE session_id = ? AND turn_id = ?",
                (source_session_id, turn_id),
            ).fetchone()
            if selected is None:
                raise KeyError(turn_id)
            turns = connection.execute(
                "SELECT turn_id, query, status, created_at, finished_at, attachments, model FROM turns "
                "WHERE session_id = ? AND created_at <= ? ORDER BY created_at ASC",
                (source_session_id, float(selected["created_at"])),
            ).fetchall()
            included_turn_ids = {str(row["turn_id"]) for row in turns}
            connection.execute(
                "INSERT INTO sessions (session_id, workspace, status, created_at, updated_at, title) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    new_session_id,
                    str(source["workspace"]),
                    "idle",
                    now,
                    now,
                    str(source["title"] or ""),
                ),
            )
            for row in turns:
                status = str(row["status"])
                if status in {"running", "queued"}:
                    status = "cancelled"
                connection.execute(
                    "INSERT INTO turns (turn_id, session_id, query, status, created_at, finished_at, attachments, model) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        f"{new_session_id}:{row['turn_id']}",
                        new_session_id,
                        str(row["query"]),
                        status,
                        float(row["created_at"]),
                        row["finished_at"] if row["finished_at"] is not None else (now if status == "cancelled" else None),
                        str(row["attachments"] or "[]"),
                        str(row["model"] or "system"),
                    ),
                )
            event_rows = connection.execute(
                "SELECT turn_id, event_type, payload, created_at FROM events "
                "WHERE session_id = ? ORDER BY event_id ASC",
                (source_session_id,),
            ).fetchall()
            for row in event_rows:
                original_turn_id = row["turn_id"]
                if original_turn_id is not None and str(original_turn_id) not in included_turn_ids:
                    continue
                copied_turn_id = (
                    f"{new_session_id}:{original_turn_id}"
                    if original_turn_id is not None
                    else None
                )
                connection.execute(
                    "INSERT INTO events (session_id, turn_id, event_type, payload, created_at) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (
                        new_session_id,
                        copied_turn_id,
                        str(row["event_type"]),
                        str(row["payload"]),
                        float(row["created_at"]),
                    ),
                )
            connection.execute(
                "INSERT INTO events (session_id, turn_id, event_type, payload, created_at) "
                "VALUES (?, NULL, ?, ?, ?)",
                (
                    new_session_id,
                    "session.created",
                    _json({"workspace": str(source["workspace"]), "forked_from": source_session_id, "turn_id": turn_id}),
                    now,
                ),
            )
            self._history_cache.pop(new_session_id, None)
            self._history_cache_access.pop(new_session_id, None)
            self._history_generation[new_session_id] = 0
        return self.get_session(new_session_id) or {
            "session_id": new_session_id,
            "workspace": str(source["workspace"]),
            "status": "idle",
            "created_at": now,
            "updated_at": now,
            "title": str(source["title"] or "新会话"),
        }

    def list_sessions(self) -> list[dict[str, Any]]:
        with self._lock, self._connection() as connection:
            rows = connection.execute(
                "SELECT session_id, workspace, status, created_at, updated_at, title, "
                "(SELECT query FROM turns WHERE turns.session_id = sessions.session_id "
                "ORDER BY created_at ASC LIMIT 1) AS first_query "
                "FROM sessions ORDER BY updated_at DESC"
            ).fetchall()
        return [
            {
                **{
                    key: row[key]
                    for key in ("session_id", "workspace", "status", "created_at", "updated_at")
                },
                "title": compact_session_title(str(row["first_query"] or ""))
                if str(row["first_query"] or "").strip()
                else str(row["title"] or "新会话").strip(),
            }
            for row in rows
        ]

    def get_session(self, session_id: str) -> dict[str, Any] | None:
        with self._lock, self._connection() as connection:
            row = connection.execute(
                "SELECT session_id, workspace, status, created_at, updated_at, title, "
                "(SELECT query FROM turns WHERE turns.session_id = sessions.session_id "
                "ORDER BY created_at ASC LIMIT 1) AS first_query "
                "FROM sessions WHERE session_id = ?",
                (session_id,),
            ).fetchone()
        if row is None:
            return None
        return {
            **{
                key: row[key]
                for key in ("session_id", "workspace", "status", "created_at", "updated_at")
            },
            "title": compact_session_title(str(row["first_query"] or ""))
            if str(row["first_query"] or "").strip()
            else str(row["title"] or "新会话").strip(),
        }

    def set_session_status(self, session_id: str, status: str) -> None:
        with self._lock, self._connection() as connection:
            connection.execute(
                "UPDATE sessions SET status = ?, updated_at = ? WHERE session_id = ?",
                (status, _now(), session_id),
            )

    def create_turn(
        self,
        turn_id: str,
        session_id: str,
        query: str,
        status: str = "running",
        attachments: list[dict[str, Any]] | None = None,
        model: str = "system",
    ) -> None:
        with self._lock, self._connection() as connection:
            connection.execute(
                "INSERT INTO turns (turn_id, session_id, query, status, created_at, finished_at, attachments, model) "
                "VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
                (turn_id, session_id, query, status, _now(), _json(attachments or []), model),
            )
            connection.execute(
                "UPDATE sessions SET title = ? WHERE session_id = ? AND (title IS NULL OR title = '')",
                (compact_session_title(query), session_id),
            )

    def enqueue_turn(
        self,
        turn_id: str,
        session_id: str,
        query: str,
        *,
        max_queued_turns: int,
        attachments: list[dict[str, Any]] | None = None,
        model: str = "system",
    ) -> dict[str, Any]:
        """Atomically accept one turn so client retries cannot duplicate work."""
        now = _now()
        with self._lock, self._connection() as connection:
            session = connection.execute(
                "SELECT title FROM sessions WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            if session is None:
                raise KeyError(session_id)

            existing = connection.execute(
                "SELECT session_id, query, status, attachments, model FROM turns WHERE turn_id = ?",
                (turn_id,),
            ).fetchone()
            if existing is not None:
                if (str(existing["session_id"]) != session_id or str(existing["query"]) != query
                        or str(existing["attachments"] or "[]") != _json(attachments or [])
                        or str(existing["model"] or "system") != model):
                    raise ValueError("Turn id already belongs to a different request")
                return {
                    "turn_id": turn_id,
                    "status": str(existing["status"]),
                    "created": False,
                    "title": str(session["title"] or "").strip() or compact_session_title(query),
                }

            queued_count = int(connection.execute(
                "SELECT COUNT(*) FROM turns WHERE session_id = ? AND status = ?",
                (session_id, "queued"),
            ).fetchone()[0])
            if queued_count >= max_queued_turns:
                raise RuntimeError("Too many queued turns for this session")

            connection.execute(
                "INSERT INTO turns (turn_id, session_id, query, status, created_at, finished_at, attachments, model) "
                "VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
                (turn_id, session_id, query, "queued", now, _json(attachments or []), model),
            )
            title = str(session["title"] or "").strip() or compact_session_title(query)
            connection.execute(
                "UPDATE sessions SET status = ?, updated_at = ?, title = ? "
                "WHERE session_id = ?",
                (
                    "running",
                    now,
                    title,
                    session_id,
                ),
            )
            payload = {"query": query, "position": queued_count + 1, "mode": "queue"}
            cursor = connection.execute(
                "INSERT INTO events (session_id, turn_id, event_type, payload, created_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (session_id, turn_id, "turn.queued", _json(payload), now),
            )
            self._history_cache.pop(session_id, None)
            self._history_cache_access.pop(session_id, None)
            self._history_generation[session_id] = self._history_generation.get(session_id, 0) + 1
            return {
                "turn_id": turn_id,
                "status": "queued",
                "created": True,
                "event_id": int(cursor.lastrowid),
                "title": title,
            }

    def queued_turns(self, session_id: str) -> list[dict[str, Any]]:
        with self._lock, self._connection() as connection:
            rows = connection.execute(
                "SELECT turn_id, query, status, created_at, attachments, model FROM turns "
                "WHERE session_id = ? AND status = ? ORDER BY created_at ASC",
                (session_id, "queued"),
            ).fetchall()
        return [
            {
                "turn_id": row["turn_id"],
                "query": row["query"],
                "status": row["status"],
                "created_at": row["created_at"],
                "attachments": _parse_json_list(row["attachments"]),
                "model": str(row["model"] or "system"),
            }
            for row in rows
        ]

    def turn_status(self, turn_id: str) -> str | None:
        with self._lock, self._connection() as connection:
            row = connection.execute(
                "SELECT session_id, status FROM turns WHERE turn_id = ?",
                (turn_id,),
            ).fetchone()
        return str(row["status"]) if row is not None else None

    def get_turn(self, turn_id: str) -> dict[str, Any] | None:
        with self._lock, self._connection() as connection:
            row = connection.execute(
                "SELECT turn_id, session_id, query, status, created_at, finished_at, attachments, model "
                "FROM turns WHERE turn_id = ?",
                (turn_id,),
            ).fetchone()
        if row is None:
            return None
        result = {key: row[key] for key in row.keys()}
        result["attachments"] = _parse_json_list(result.get("attachments"))
        return result

    def turn_session_id(self, turn_id: str) -> str | None:
        with self._lock, self._connection() as connection:
            row = connection.execute(
                "SELECT session_id FROM turns WHERE turn_id = ?",
                (turn_id,),
            ).fetchone()
        return str(row["session_id"]) if row is not None else None

    def set_turn_status(self, turn_id: str, status: str) -> None:
        with self._lock, self._connection() as connection:
            connection.execute(
                "UPDATE turns SET status = ?, finished_at = ? WHERE turn_id = ?",
                (status, _now(), turn_id),
            )

    def mark_turn_running(self, turn_id: str) -> None:
        with self._lock, self._connection() as connection:
            connection.execute(
                "UPDATE turns SET status = ?, finished_at = NULL WHERE turn_id = ?",
                ("running", turn_id),
            )

    def append_event(
        self,
        session_id: str,
        turn_id: str | None,
        event_type: str,
        payload: dict[str, Any],
    ) -> int:
        with self._lock, self._connection() as connection:
            cursor = connection.execute(
                "INSERT INTO events (session_id, turn_id, event_type, payload, created_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (session_id, turn_id, event_type, _json(payload), _now()),
            )
            self._history_cache.pop(session_id, None)
            self._history_cache_access.pop(session_id, None)
            self._history_generation[session_id] = self._history_generation.get(session_id, 0) + 1
            return int(cursor.lastrowid)

    def events_after(
        self,
        session_id: str,
        after: int,
        *,
        summary: bool = False,
    ) -> list[dict[str, Any]]:
        with self._lock, self._connection() as connection:
            rows = connection.execute(
                "SELECT event_id, turn_id, event_type, payload, created_at FROM events "
                "WHERE session_id = ? AND event_id > ? ORDER BY event_id ASC",
                (session_id, after),
            ).fetchall()
        events = [
            {
                "event_id": row["event_id"],
                "turn_id": row["turn_id"],
                "event_type": row["event_type"],
                "payload": json.loads(row["payload"]),
                "created_at": row["created_at"],
            }
            for row in rows
        ]
        return [_summary_event(event) for event in events] if summary else events

    def get_event(self, session_id: str, event_id: int) -> dict[str, Any] | None:
        with self._lock, self._connection() as connection:
            row = connection.execute(
                "SELECT event_id, turn_id, event_type, payload, created_at FROM events "
                "WHERE session_id = ? AND event_id = ?",
                (session_id, event_id),
            ).fetchone()
        if row is None:
            return None
        return {
            "event_id": row["event_id"],
            "turn_id": row["turn_id"],
            "event_type": row["event_type"],
            "payload": json.loads(row["payload"]),
            "created_at": row["created_at"],
        }

    def history_events_after(
        self,
        session_id: str,
        after: int = 0,
        *,
        summary: bool = False,
    ) -> list[dict[str, Any]]:
        """Return a complete history with low-value lifecycle events folded."""
        if after == 0:
            with self._lock:
                cached = self._history_cache.get(session_id)
                if cached is not None:
                    self._history_cache_access[session_id] = time.monotonic()
                    result = list(cached)
                    return [_summary_event(event) for event in result] if summary else result
                generation = self._history_generation.get(session_id, 0)
        events = self.events_after(session_id, after)
        if after != 0:
            return [_summary_event(event) for event in events] if summary else events
        compacted = _fold_history_events(events)
        if after == 0:
            with self._lock:
                if self._history_generation.get(session_id, 0) == generation:
                    self._history_cache[session_id] = compacted
                    self._history_cache_access[session_id] = time.monotonic()
                    while len(self._history_cache) > MAX_HISTORY_CACHE_SESSIONS:
                        stale_id = min(
                            self._history_cache_access,
                            key=self._history_cache_access.get,
                        )
                        self._history_cache.pop(stale_id, None)
                        self._history_cache_access.pop(stale_id, None)
        return [_summary_event(event) for event in compacted] if summary else compacted

    def history_events_tail(
        self,
        session_id: str,
        limit: int,
        *,
        summary: bool = False,
    ) -> tuple[list[dict[str, Any]], bool, int | None, int | None]:
        """Return the newest compact history window without replaying the session."""
        bounded_limit = max(1, limit)
        with self._lock, self._connection() as connection:
            rows = connection.execute(
                "SELECT event_id, turn_id, event_type, payload, created_at FROM events "
                "WHERE session_id = ? ORDER BY event_id DESC LIMIT ?",
                (session_id, bounded_limit + 1),
            ).fetchall()
        has_more = len(rows) > bounded_limit
        selected = list(reversed(rows[:bounded_limit]))
        events = [
            {
                "event_id": row["event_id"],
                "turn_id": row["turn_id"],
                "event_type": row["event_type"],
                "payload": json.loads(row["payload"]),
                "created_at": row["created_at"],
            }
            for row in selected
        ]
        compacted = _fold_history_events(events)
        return (
            [_summary_event(event) for event in compacted] if summary else compacted,
            has_more,
            int(selected[0]["event_id"]) if selected else None,
            int(selected[-1]["event_id"]) if selected else None,
        )

    def history_events_before(
        self,
        session_id: str,
        before: int,
        limit: int,
        *,
        summary: bool = False,
    ) -> tuple[list[dict[str, Any]], bool, int | None, int | None]:
        """Page older compact history while keeping the newest UI responsive."""
        bounded_limit = max(1, limit)
        with self._lock, self._connection() as connection:
            rows = connection.execute(
                "SELECT event_id, turn_id, event_type, payload, created_at FROM events "
                "WHERE session_id = ? AND event_id < ? ORDER BY event_id DESC LIMIT ?",
                (session_id, before, bounded_limit + 1),
            ).fetchall()
        has_more = len(rows) > bounded_limit
        selected = list(reversed(rows[:bounded_limit]))
        events = [
            {
                "event_id": row["event_id"],
                "turn_id": row["turn_id"],
                "event_type": row["event_type"],
                "payload": json.loads(row["payload"]),
                "created_at": row["created_at"],
            }
            for row in selected
        ]
        compacted = _fold_history_events(events)
        return (
            [_summary_event(event) for event in compacted] if summary else compacted,
            has_more,
            int(selected[0]["event_id"]) if selected else None,
            int(selected[-1]["event_id"]) if selected else None,
        )

    def conversation_events(self, session_id: str) -> list[dict[str, Any]]:
        """Read only user/assistant turns needed to warm an AgentRuntime."""
        with self._lock, self._connection() as connection:
            rows = connection.execute(
                "SELECT event_id, turn_id, event_type, payload, created_at FROM events "
                "WHERE session_id = ? AND event_type IN (?, ?) ORDER BY event_id ASC",
                (session_id, "turn.started", "assistant.message"),
            ).fetchall()
        return [
            {
                "event_id": row["event_id"],
                "turn_id": row["turn_id"],
                "event_type": row["event_type"],
                "payload": json.loads(row["payload"]),
                "created_at": row["created_at"],
            }
            for row in rows
        ]

    def create_approval(
        self,
        approval_id: str,
        session_id: str,
        turn_id: str,
        tool_name: str,
        tool_input: dict[str, Any],
    ) -> None:
        with self._lock, self._connection() as connection:
            connection.execute(
                "INSERT INTO approvals VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
                (
                    approval_id,
                    session_id,
                    turn_id,
                    tool_name,
                    _json(tool_input),
                    "pending",
                    _now(),
                ),
            )

    def resolve_approval(self, approval_id: str, approved: bool) -> None:
        status = "approved" if approved else "denied"
        with self._lock, self._connection() as connection:
            connection.execute(
                "UPDATE approvals SET status = ?, resolved_at = ? WHERE approval_id = ?",
                (status, _now(), approval_id),
            )
