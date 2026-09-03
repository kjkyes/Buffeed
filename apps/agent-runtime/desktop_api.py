#!/usr/bin/env python3
"""Loopback-only FastAPI adapter for the Buffeed desktop application."""

from __future__ import annotations

import asyncio
import difflib
import importlib.util
import json
import logging
import mimetypes
import os
import re
import sqlite3
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import urllib.parse
import urllib.request
from collections import deque
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field
from dotenv import load_dotenv

APP_RUNTIME_DIR = Path(__file__).resolve().parent
REPO_ROOT = APP_RUNTIME_DIR.parents[1]
load_dotenv(REPO_ROOT / ".env", override=True)
if not (APP_RUNTIME_DIR / "Buffeed_core.py").is_file():
    raise ImportError(f"Canonical Buffeed source was not found: {APP_RUNTIME_DIR / 'Buffeed_core.py'}")
if str(APP_RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(APP_RUNTIME_DIR))
from paths import buffeed_home, load_buffeed_env
load_buffeed_env()
from runtime_store import DesktopStore
from team_events import TeamEventJournal
from team_observer import build_team_snapshot


LOGGER = logging.getLogger("agent-runtime.desktop")


API_HOST = os.getenv("DESKTOP_API_HOST", "127.0.0.1")
API_PORT = int(os.getenv("DESKTOP_API_PORT", "8765"))
BUFFEED_PATH = APP_RUNTIME_DIR / "Buffeed.py"
STATE_DIR = Path(os.getenv("DESKTOP_STATE_DIR", str(buffeed_home() / "state"))).expanduser().resolve()
STATE_DB = STATE_DIR / "desktop.db"
APPROVAL_TIMEOUT_SECONDS = int(os.getenv("DESKTOP_APPROVAL_TIMEOUT_SECONDS", "600"))
TEAM_MUTATION_TOOLS = {
    "spawn_teammate",
    "send_message",
    "check_inbox",
    "request_shutdown",
    "request_plan",
    "review_plan",
}
MAX_RUNTIME_SESSIONS = max(
    1, int(os.getenv("DESKTOP_MAX_RUNTIME_SESSIONS", "4"))
)
WARM_SESSION_COUNT = min(
    MAX_RUNTIME_SESSIONS,
    max(0, int(os.getenv("DESKTOP_WARM_SESSION_COUNT", "3"))),
)
HISTORY_WINDOW_EVENTS = max(
    25, min(500, int(os.getenv("DESKTOP_HISTORY_WINDOW_EVENTS", "200")))
)
MAX_QUEUED_TURNS = max(
    1, int(os.getenv("DESKTOP_MAX_QUEUED_TURNS", "32"))
)
MAX_PENDING_STEERS = max(
    1, int(os.getenv("DESKTOP_MAX_PENDING_STEERS", "8"))
)
MAX_TURN_ATTACHMENTS = 16
MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024
MAX_ATTACHMENT_PREVIEW_URL_CHARS = 750_000
TEAM_CANCEL_REPORT_TIMEOUT_SECONDS = max(
    1.0, float(os.getenv("DESKTOP_TEAM_CANCEL_REPORT_TIMEOUT_SECONDS", "10"))
)
# Team tools are available to the current turn. Member threads are suspended
# at turn boundaries so an old Team cannot be reused by a later request.
TEAM_TOOLS_ENABLED = True

# These CLI features share module-global queues or spawn untracked threads. They
# remain available to the CLI, but the desktop API keeps turns isolated.
DESKTOP_DISABLED_TOOLS = {
    "task",
    "schedule_cron",
    "list_crons",
    "cancel_cron",
    "create_worktree",
    "remove_worktree",
    "keep_worktree",
}

DEFAULT_MODEL_ALIAS = "system"


def configured_primary_model() -> str:
    return os.getenv("MODEL_ID", "").strip()


def configured_turn_models() -> list[dict[str, Any]]:
    """Expose only configured runtime model capabilities to desktop clients."""
    primary_model = configured_primary_model()
    raw_models = os.getenv("DASHSCOPE_VIDEO_MODELS", "").strip()
    configured = raw_models.split(",") if raw_models else [os.getenv("DASHSCOPE_VIDEO_MODEL", "").strip()]
    models: list[dict[str, Any]] = []
    seen: set[str] = set()
    if primary_model:
        models.append({
            "id": primary_model,
            "label": primary_model,
            "provider": "anthropic-compatible",
            "supports_video": False,
        })
        seen.add(primary_model)
    for value in configured:
        model_id = value.strip()
        if not model_id or model_id in seen:
            continue
        seen.add(model_id)
        models.append({
            "id": model_id,
            "label": model_id,
            "provider": "dashscope",
            "supports_video": True,
        })
    return models


def configured_turn_model_ids() -> set[str]:
    return {str(item["id"]) for item in configured_turn_models()}


def resolve_turn_model(model: str | None) -> str:
    requested = str(model or DEFAULT_MODEL_ALIAS).strip()
    if requested == DEFAULT_MODEL_ALIAS:
        requested = configured_primary_model()
    if not requested:
        raise ValueError("MODEL_ID must be configured before submitting a turn")
    if requested not in configured_turn_model_ids():
        raise ValueError("不支持的模型")
    return requested


def _now() -> float:
    return time.time()


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=str, separators=(",", ":"))


def _log_timing(operation: str, started_at: float, **fields: Any) -> None:
    payload = {
        "operation": operation,
        "duration_ms": round((time.perf_counter() - started_at) * 1000, 2),
        **fields,
    }
    LOGGER.info("runtime_timing %s", _json(payload))


def _git_run(workspace: Path, args: list[str], timeout: float = 20) -> tuple[int, str, str]:
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=workspace,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
        return result.returncode, result.stdout, result.stderr
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 1, "", str(exc)


def _normalize_git_path(path: str) -> str:
    return path.replace("\\", "/").strip()


_INTERNAL_RUNTIME_PATH_PREFIXES = (
    ".session-memory",
    ".memory",
    ".transcripts",
    ".task_outputs",
    ".desktop-state",
)


def _is_internal_runtime_path(path: str) -> bool:
    normalized = _normalize_git_path(path).strip("/")
    return any(
        normalized == prefix or normalized.startswith(f"{prefix}/")
        for prefix in _INTERNAL_RUNTIME_PATH_PREFIXES
    )


def _git_status_entries(workspace: Path) -> dict[str, str]:
    code, output, _ = _git_run(
        workspace,
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )
    if code != 0:
        return {}
    entries: dict[str, str] = {}
    records = output.split("\0")
    index = 0
    while index < len(records):
        record = records[index]
        index += 1
        if len(record) < 4:
            continue
        entries[_normalize_git_path(record[3:])] = record[:2]
        if record[:2].strip()[:1] in {"R", "C"}:
            index += 1
    return entries


def _git_status_paths(workspace: Path) -> set[str]:
    return set(_git_status_entries(workspace))


def _git_diff_hunks(workspace: Path, path: str) -> list[dict[str, int]]:
    code, output, _ = _git_run(
        workspace,
        ["diff", "HEAD", "--no-ext-diff", "--unified=0", "--", path],
    )
    if code != 0:
        return []
    hunks: list[dict[str, int]] = []
    for line in output.splitlines():
        match = re.match(r"^@@ .* \+(\d+)(?:,(\d+))? @@", line)
        if not match:
            continue
        start = int(match.group(1))
        count = int(match.group(2) or "1")
        end = start + max(count - 1, 0)
        hunks.append({"startLine": max(1, start), "endLine": max(1, end)})
    return hunks


def _parse_unified_diff(output: str, max_lines: int = 240) -> list[dict[str, Any]]:
    lines: list[dict[str, Any]] = []
    old_line = 0
    new_line = 0
    for raw_line in output.splitlines():
        header = re.match(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@", raw_line)
        if header:
            old_line = int(header.group(1))
            new_line = int(header.group(2))
            continue
        if raw_line.startswith(("--- ", "+++ ", "\\ No newline")):
            continue
        if raw_line.startswith(" "):
            lines.append({
                "kind": "context",
                "oldLine": old_line,
                "newLine": new_line,
                "text": raw_line[1:],
            })
            old_line += 1
            new_line += 1
        elif raw_line.startswith("-"):
            lines.append({"kind": "deletion", "oldLine": old_line, "text": raw_line[1:]})
            old_line += 1
        elif raw_line.startswith("+"):
            lines.append({"kind": "addition", "newLine": new_line, "text": raw_line[1:]})
            new_line += 1
        if len(lines) >= max_lines:
            break
    return lines


def _git_diff_lines(workspace: Path, path: str) -> list[dict[str, Any]]:
    code, output, _ = _git_run(
        workspace,
        ["diff", "HEAD", "--no-ext-diff", "--no-color", "--unified=3", "--", path],
    )
    return _parse_unified_diff(output) if code == 0 else []


def _git_change_snapshot(
    workspace: Path,
    *,
    line_count_paths: set[str] | None = None,
) -> dict[str, Any]:
    status_entries = {
        path: status
        for path, status in _git_status_entries(workspace).items()
        if not _is_internal_runtime_path(path)
    }
    status_paths = set(status_entries)
    files: dict[str, dict[str, Any]] = {
        path: {"path": path, "additions": 0, "deletions": 0, "hunks": [], "status": "modified"}
        for path in status_paths
    }
    code, output, _ = _git_run(
        workspace,
        ["diff", "HEAD", "--numstat", "--no-renames", "-z", "--"],
    )
    if code == 0:
        for record in output.split("\0"):
            fields = record.split("\t", 2)
            if len(fields) != 3:
                continue
            additions, deletions, raw_path = fields
            path = _normalize_git_path(raw_path)
            if not path or _is_internal_runtime_path(path):
                continue
            entry = files.setdefault(
                path,
                {"path": path, "additions": 0, "deletions": 0, "hunks": [], "status": "modified"},
            )
            entry["additions"] = int(additions) if additions.isdigit() else 0
            entry["deletions"] = int(deletions) if deletions.isdigit() else 0
            entry["hunks"] = _git_diff_hunks(workspace, path)
            entry["diffLines"] = _git_diff_lines(workspace, path)

    readable_untracked_paths = set(line_count_paths or ())
    for path, entry in files.items():
        absolute = (workspace / Path(path)).resolve()
        try:
            absolute.relative_to(workspace)
        except ValueError:
            continue
        if path not in status_paths:
            continue
        status_text = status_entries.get(path, "")
        is_untracked = status_text.startswith("??")
        if (
            is_untracked
            and path in readable_untracked_paths
            and entry["additions"] == 0
            and entry["deletions"] == 0
            and absolute.is_file()
        ):
            try:
                line_count = len(absolute.read_text(encoding="utf-8", errors="replace").splitlines())
            except OSError:
                line_count = 0
            entry["additions"] = line_count
            entry["hunks"] = ([{"startLine": 1, "endLine": max(1, line_count)}] if line_count else [])
            entry["diffLines"] = [
                {"kind": "addition", "newLine": index, "text": line}
                for index, line in enumerate(
                    absolute.read_text(encoding="utf-8", errors="replace").splitlines(),
                    start=1,
                )
            ][:240]
        entry["status"] = "untracked" if is_untracked else (
            "deleted" if "D" in status_text[:2] else "modified"
        )

    ordered = sorted(files.values(), key=lambda item: (-item["additions"] - item["deletions"], item["path"]))
    return {
        "available": True,
        "files": ordered,
        "total_files": len(ordered),
        "total_additions": sum(item["additions"] for item in ordered),
        "total_deletions": sum(item["deletions"] for item in ordered),
    }


_FILE_MISSING = object()


def _file_snapshot(path: Path) -> str | object:
    if not path.is_file():
        return _FILE_MISSING
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return _FILE_MISSING


def _workspace_file_snapshots(
    workspace: Path,
    extra_paths: set[str] | None = None,
) -> dict[str, str | object]:
    """Capture only paths observed during this turn.

    Existing dirty files are tracked by Git status, but reading every dirty
    file at a turn boundary makes large workspaces (especially node_modules)
    block the HTTP request. Tool events add the small set of paths that need a
    before/after content snapshot.
    """
    paths = set(extra_paths or ())
    snapshots: dict[str, str | object] = {}
    for path in paths:
        absolute = (workspace / Path(path)).resolve()
        try:
            absolute.relative_to(workspace)
            snapshots[path] = _file_snapshot(absolute)
        except ValueError:
            continue
    return snapshots


def _line_delta(previous: str | object, current: str | object) -> tuple[int, int]:
    before = [] if previous is _FILE_MISSING else str(previous).splitlines()
    after = [] if current is _FILE_MISSING else str(current).splitlines()
    additions = 0
    deletions = 0
    for tag, before_start, before_end, after_start, after_end in difflib.SequenceMatcher(
        None, before, after
    ).get_opcodes():
        if tag in {"replace", "insert"}:
            additions += after_end - after_start
        if tag in {"replace", "delete"}:
            deletions += before_end - before_start
    return additions, deletions


def _line_diff_lines(previous: str | object, current: str | object) -> list[dict[str, Any]]:
    before = [] if previous is _FILE_MISSING else str(previous).splitlines()
    after = [] if current is _FILE_MISSING else str(current).splitlines()
    return _parse_unified_diff(
        "\n".join(
            difflib.unified_diff(before, after, fromfile="before", tofile="after", n=3)
        )
    )


def _command_file_paths(command: str) -> set[str]:
    """Extract paths from common shell create/delete/redirection commands."""
    paths: set[str] = set()
    variables = _powershell_path_variables(command)
    patterns = (
        r"(?:^|[\s;&|])(?:touch|rm|del|erase)\s+(?:-f\s+)?(?P<path>[^\s;&|]+)",
        r"(?:^|[\s;&|])(?:New-Item|Remove-Item)\s+(?:-[^\s]+\s+)*['\"]?(?P<path>[^'\"\s;&|]+)",
        r"(?<![\w-])(?:-Path|-File)\s+['\"]?(?P<path>[^'\"\s;&|]+)",
        r"(?:^|[\s;&|])(?:\d?>|>>)\s*['\"]?(?P<path>[^'\"\s;&|]+)",
    )
    for pattern in patterns:
        for match in re.finditer(pattern, command, flags=re.IGNORECASE):
            candidate = match.group("path").strip().strip("'\"").rstrip("),;]\\")
            candidate = variables.get(candidate, candidate)
            if candidate and not candidate.startswith(("-", "(", "$((")):
                paths.add(candidate)
    return paths


_POWERSHELL_VALUE = r"(?:'((?:''|[^'])*)'|\"((?:\"\"|[^\"])*)\"|([^\s;&|]+))"


def _powershell_argument(arguments: str, name: str) -> str | None:
    match = re.search(
        rf"-{name}\s+{_POWERSHELL_VALUE}",
        arguments,
        flags=re.IGNORECASE,
    )
    if not match:
        return None
    value = next((group for group in match.groups() if group is not None), "")
    return value.replace("''", "'").replace('""', '"').strip()


def _powershell_path_variables(command: str) -> dict[str, str]:
    variables: dict[str, str] = {}
    patterns = (
        r"\$(?P<name>[A-Za-z_]\w*)\s*=\s*Join-Path\s+"
        r"(?:\(Get-Location\)|\$PWD|\$PSScriptRoot)\s+"
        r"(?P<path>'[^']+'|\"[^\"]+\")",
        r"\$(?P<name>[A-Za-z_]\w*)\s*=\s*(?P<path>'[^']+'|\"[^\"]+\")",
    )
    for pattern in patterns:
        for match in re.finditer(pattern, command, flags=re.IGNORECASE):
            raw_path = match.group("path").strip().strip("'\"")
            if raw_path:
                variables[f"${match.group('name')}"] = raw_path
    return variables


def _powershell_here_string(command: str) -> str | None:
    match = re.search(r"@'(?P<body>.*?)'@", command, flags=re.DOTALL)
    if match is None:
        match = re.search(r'@"(?P<body>.*?)"@', command, flags=re.DOTALL)
    if match is None:
        return None
    return match.group("body").strip("\r\n")


def _command_file_operations(command: str) -> dict[str, dict[str, Any]]:
    """Describe file writes/deletes that happen inside one shell command."""
    operations: dict[str, dict[str, Any]] = {}
    variables = _powershell_path_variables(command)
    here_string = _powershell_here_string(command)
    command_pattern = r"(?<![\w-])(?P<verb>Set-Content|Add-Content|Out-File|New-Item|Remove-Item|touch|rm|del|erase)\b(?P<arguments>[^;&|\n]*)"
    for match in re.finditer(command_pattern, command, flags=re.IGNORECASE):
        verb = match.group("verb").lower()
        arguments = match.group("arguments")
        if verb in {"set-content", "add-content", "out-file", "new-item"}:
            raw_path = _powershell_argument(arguments, "Path") or _powershell_argument(arguments, "FilePath")
            if not raw_path:
                continue
            raw_value = _powershell_argument(arguments, "Value")
            if raw_value is None and here_string is not None:
                raw_value = here_string
            full_value = _powershell_argument(command[match.start():], "Value")
            if full_value and (arguments.count("'") % 2 == 1 or len(full_value) > len(raw_value or "")):
                raw_value = full_value
            line_count = len(raw_value.splitlines()) if raw_value else 0
            if raw_value and line_count == 0:
                line_count = 1
        else:
            raw_path = _powershell_argument(arguments, "Path")
            if raw_path is None:
                raw_path = arguments.strip().split()[0] if arguments.strip() else None
            line_count = 0
        if not raw_path:
            continue
        raw_path = variables.get(raw_path.strip(), raw_path)
        path = _normalize_git_path(raw_path).strip("'\"").rstrip(")],;/\\")
        if not path or path.startswith("-"):
            continue
        operation = operations.setdefault(
            path,
            {"created": False, "deleted": False, "created_lines": 0, "created_content": ""},
        )
        if verb in {"set-content", "add-content", "out-file", "new-item", "touch"}:
            operation["created"] = True
            operation["created_lines"] = max(operation["created_lines"], line_count)
            if raw_value:
                operation["created_content"] = raw_value
        else:
            operation["deleted"] = True

    redirection_pattern = (
        r"(?<![\w-])(?:echo|printf|Write-Output)\s+"
        r"(?P<value>.*?)\s*(?P<redirect>>{1,2})\s*"
        r"['\"]?(?P<path>[^'\"\s;&|]+)"
    )
    for match in re.finditer(redirection_pattern, command, flags=re.IGNORECASE):
        raw_value = match.group("value").strip()
        if len(raw_value) >= 2 and raw_value[0] == raw_value[-1] and raw_value[0] in "'\"":
            raw_value = raw_value[1:-1]
        raw_value = raw_value.replace("\\n", "\n")
        raw_path = match.group("path").strip().strip("'\"")
        raw_path = variables.get(raw_path, raw_path)
        if not raw_path:
            continue
        line_count = len(raw_value.splitlines()) if raw_value else 0
        if raw_value and line_count == 0:
            line_count = 1
        operation = operations.setdefault(
            raw_path,
            {"created": False, "deleted": False, "created_lines": 0, "created_content": ""},
        )
        operation["created"] = True
        operation["created_lines"] = max(operation["created_lines"], line_count)
        if raw_value:
            operation["created_content"] = raw_value
    return operations


class _LegacyDesktopStore:
    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path
        self._lock = threading.Lock()

    def initialize(self) -> None:
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connection() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS sessions (
                    session_id TEXT PRIMARY KEY,
                    workspace TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS turns (
                    turn_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    query TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    finished_at REAL
                );
                CREATE TABLE IF NOT EXISTS events (
                    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    turn_id TEXT,
                    event_type TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    created_at REAL NOT NULL
                );
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

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path)
        connection.row_factory = sqlite3.Row
        return connection

    @contextmanager
    def _connection(self):
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
                "INSERT INTO sessions VALUES (?, ?, ?, ?, ?)",
                (session_id, str(workspace), "idle", now, now),
            )

    def list_sessions(self) -> list[dict[str, Any]]:
        with self._lock, self._connection() as connection:
            rows = connection.execute(
                "SELECT session_id, workspace, status, created_at, updated_at "
                "FROM sessions ORDER BY updated_at DESC"
            ).fetchall()
        return [dict(row) for row in rows]

    def get_session(self, session_id: str) -> dict[str, Any] | None:
        with self._lock, self._connection() as connection:
            row = connection.execute(
                "SELECT session_id, workspace, status, created_at, updated_at "
                "FROM sessions WHERE session_id = ?",
                (session_id,),
            ).fetchone()
        return dict(row) if row else None

    def set_session_status(self, session_id: str, status: str) -> None:
        with self._lock, self._connection() as connection:
            connection.execute(
                "UPDATE sessions SET status = ?, updated_at = ? WHERE session_id = ?",
                (status, _now(), session_id),
            )

    def create_turn(self, turn_id: str, session_id: str, query: str) -> None:
        with self._lock, self._connection() as connection:
            connection.execute(
                "INSERT INTO turns VALUES (?, ?, ?, ?, ?, NULL)",
                (turn_id, session_id, query, "running", _now()),
            )

    def set_turn_status(self, turn_id: str, status: str) -> None:
        with self._lock, self._connection() as connection:
            connection.execute(
                "UPDATE turns SET status = ?, finished_at = ? WHERE turn_id = ?",
                (status, _now(), turn_id),
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
            return int(cursor.lastrowid)

    def events_after(self, session_id: str, after: int) -> list[dict[str, Any]]:
        with self._lock, self._connection() as connection:
            rows = connection.execute(
                "SELECT event_id, turn_id, event_type, payload, created_at FROM events "
                "WHERE session_id = ? AND event_id > ? ORDER BY event_id ASC",
                (session_id, after),
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


@dataclass
class EventBroker:
    store: DesktopStore
    session_id: str
    _events: deque[dict[str, Any]] = field(default_factory=lambda: deque(maxlen=1024))
    _condition: threading.Condition = field(default_factory=threading.Condition)

    def publish(
        self,
        event_type: str,
        payload: dict[str, Any],
        turn_id: str | None = None,
    ) -> dict[str, Any]:
        event_id = self.store.append_event(
            self.session_id, turn_id, event_type, payload
        )
        event = {
            "event_id": event_id,
            "turn_id": turn_id,
            "event_type": event_type,
            "payload": payload,
            "created_at": _now(),
        }
        with self._condition:
            self._events.append(event)
            self._condition.notify_all()
        return event

    def wake(self) -> None:
        """Wake SSE consumers after an event was persisted without this broker."""
        with self._condition:
            self._condition.notify_all()

    def wait_after(self, after: int, timeout_seconds: float) -> list[dict[str, Any]]:
        with self._condition:
            matches = [event for event in self._events if event["event_id"] > after]
            if not matches:
                self._condition.wait(timeout_seconds)
                matches = [event for event in self._events if event["event_id"] > after]
        # The in-memory deque is only a wake-up accelerator. A reconnect or a
        # slow consumer can fall behind its bounded window, so always reconcile
        # with SQLite before returning a batch.
        durable = self.store.events_after(self.session_id, after)
        by_id = {event["event_id"]: event for event in durable}
        by_id.update({event["event_id"]: event for event in matches})
        return [by_id[event_id] for event_id in sorted(by_id)]


@dataclass
class PendingApproval:
    approval_id: str
    turn_id: str
    event: threading.Event = field(default_factory=threading.Event)
    approved: bool | None = None


class ApprovalBroker:
    def __init__(self, runtime: "SessionRuntime") -> None:
        self.runtime = runtime
        self._lock = threading.Lock()
        self._pending: dict[str, PendingApproval] = {}

    def request(self, block, turn_id: str) -> bool:
        approval_id = str(uuid.uuid4())
        pending = PendingApproval(approval_id=approval_id, turn_id=turn_id)
        tool_name = getattr(block, "name", "unknown")
        tool_input = dict(getattr(block, "input", {}) or {})
        self.runtime.manager.store.create_approval(
            approval_id,
            self.runtime.session_id,
            turn_id,
            tool_name,
            tool_input,
        )
        with self._lock:
            self._pending[approval_id] = pending
        self.runtime.publish(
            "approval.requested",
            {
                "approval_id": approval_id,
                "tool_name": tool_name,
                "input": tool_input,
                "timeout_seconds": APPROVAL_TIMEOUT_SECONDS,
            },
            turn_id,
        )

        deadline = time.monotonic() + APPROVAL_TIMEOUT_SECONDS
        while not pending.event.wait(timeout=0.25):
            if self.runtime.cancel_event.is_set() or time.monotonic() >= deadline:
                break

        with self._lock:
            self._pending.pop(approval_id, None)
        approved = pending.approved is True and not self.runtime.cancel_event.is_set()
        self.runtime.manager.store.resolve_approval(approval_id, approved)
        self.runtime.publish(
            "approval.resolved",
            {"approval_id": approval_id, "approved": approved},
            turn_id,
        )
        return approved

    def resolve(self, approval_id: str, approved: bool) -> bool:
        with self._lock:
            pending = self._pending.get(approval_id)
            if pending is None:
                return False
            pending.approved = approved
            pending.event.set()
            return True

    def has_pending(self, turn_id: str) -> bool:
        with self._lock:
            return any(item.turn_id == turn_id for item in self._pending.values())

    def cancel_all(self) -> None:
        with self._lock:
            pending = list(self._pending.values())
        for approval in pending:
            approval.approved = False
            approval.event.set()


@dataclass
class SessionRuntime:
    manager: "DesktopManager"
    session_id: str
    workspace: Path
    Buffeed: Any
    agent_session: Any
    broker: EventBroker
    cancel_event: threading.Event = field(default_factory=threading.Event)
    turn_lock: threading.Lock = field(default_factory=threading.Lock)
    active_turn_id: str | None = None
    turn_thread: threading.Thread | None = None
    team_lock: threading.Lock = field(default_factory=threading.Lock)
    active_team_execution_id: str | None = None
    last_team_execution_id: str | None = None
    team_run_execution_ids: dict[str, str] = field(default_factory=dict)
    team_execution_turn_ids: dict[str, str | None] = field(default_factory=dict)
    team_plan_executions: set[str] = field(default_factory=set)
    team_lead_started: set[str] = field(default_factory=set)
    team_lead_finished: set[str] = field(default_factory=set)
    team_lead_task_ids: dict[str, str | None] = field(default_factory=dict)
    team_execution_started_at: dict[str, float] = field(default_factory=dict)
    baseline_paths: set[str] = field(default_factory=set)
    turn_file_snapshots: dict[str, str | object] = field(default_factory=dict)
    turn_file_ledger: dict[str, dict[str, Any]] = field(default_factory=dict)
    turn_pending_file_ops: dict[str, dict[str, dict[str, Any]]] = field(default_factory=dict)
    turn_lifecycle_counts: dict[str, int] = field(default_factory=dict)
    cancel_requested_member_names: list[str] = field(default_factory=list)
    queued_turns: deque[tuple[str, str, list[dict[str, Any]], str]] = field(default_factory=deque)
    steer_lock: threading.Lock = field(default_factory=threading.Lock)
    pending_steers: deque[dict[str, Any]] = field(default_factory=deque)

    def __post_init__(self) -> None:
        self.baseline_paths = self.manager.project_baseline_paths(self.workspace)
        self.approvals = ApprovalBroker(self)
        self.team_journal = TeamEventJournal(
            execution_id=self.session_id,
            publish=self.broker.publish,
            replay=lambda after: self.manager.store.events_after(self.session_id, after),
        )

    def changes_snapshot(self, *, include_protected: bool = False) -> dict[str, Any]:
        baseline_paths = self._baseline_for_snapshot()
        # The turn ledger is the stable source of truth while a turn is active
        # and for the last completed turn. Git is only a fallback for a cold
        # session with no turn-local observations.
        snapshot = (
            {
                "available": True,
                "files": [],
                "total_files": 0,
                "total_additions": 0,
                "total_deletions": 0,
            }
            if self.active_turn_id is not None or self.turn_file_ledger
            else _git_change_snapshot(self.workspace)
        )
        files = {item["path"]: item for item in snapshot["files"]}
        for path, delta in self.turn_file_ledger.items():
            if _is_internal_runtime_path(path):
                continue
            additions = delta["additions"]
            deletions = delta["deletions"]
            if not additions and not deletions:
                continue
            if delta.get("created") and delta.get("deleted"):
                change_type = "transient"
            elif delta.get("deleted"):
                change_type = "deleted"
            elif delta.get("created"):
                change_type = "created"
            else:
                change_type = "modified"
            item = files.get(path)
            if item is None:
                item = {
                    "path": path,
                    "additions": additions,
                    "deletions": deletions,
                    "hunks": [{"startLine": 1, "endLine": max(1, additions)}],
                    "diffLines": delta.get("diff_lines", []),
                    "status": change_type,
                }
                files[path] = item
            else:
                # A touched path is measured from this turn's first snapshot;
                # do not carry pre-existing worktree changes into this HUD.
                item["additions"] = additions
                item["deletions"] = deletions
                item["diffLines"] = delta.get("diff_lines", item.get("diffLines", []))
                item["status"] = change_type
        files = {
            path: item for path, item in files.items() if not _is_internal_runtime_path(path)
        }
        if not include_protected:
            touched_paths = set(self.turn_file_ledger)
            files = {
                path: item
                for path, item in files.items()
                if path not in baseline_paths or path in touched_paths
            }
        ordered = sorted(
            files.values(),
            key=lambda item: (-item["additions"] - item["deletions"], item["path"]),
        )
        snapshot["files"] = ordered
        snapshot["total_files"] = len(ordered)
        snapshot["total_additions"] = sum(item["additions"] for item in ordered)
        snapshot["total_deletions"] = sum(item["deletions"] for item in ordered)
        snapshot["created_files"] = sum(
            1 for item in ordered if item.get("status") in {"untracked", "created", "transient"}
        )
        snapshot["deleted_files"] = sum(
            1 for item in ordered if item.get("status") in {"deleted", "transient"}
        )
        snapshot["modified_files"] = sum(
            1 for item in ordered if item.get("status") == "modified"
        )
        return snapshot

    def _baseline_for_snapshot(self) -> set[str]:
        # Keep the session's turn-start baseline stable after the async project
        # cache refresh; otherwise a completed turn's own files become
        # protected before the HUD can request a revert.
        return set(self.baseline_paths)

    def _await_team_cancellation_reports(
        self,
        member_names: list[str],
    ) -> list[dict[str, Any]]:
        """Wait briefly for members to report their last completed boundary."""
        expected = {str(name) for name in member_names if str(name).strip()}
        if not expected:
            return []
        getter = getattr(self.Buffeed, "get_team_cancellation_reports", None)
        if not callable(getter):
            return []
        deadline = time.monotonic() + TEAM_CANCEL_REPORT_TIMEOUT_SECONDS
        reports: list[dict[str, Any]] = []
        while True:
            try:
                reports = [
                    dict(report)
                    for report in getter()
                    if isinstance(report, dict)
                    and str(report.get("name") or "") in expected
                ]
            except Exception:
                reports = []
            if {str(report.get("name") or "") for report in reports} >= expected:
                break
            if time.monotonic() >= deadline:
                break
            time.sleep(0.1)
        return sorted(reports, key=lambda report: str(report.get("name") or ""))

    def _build_cancellation_summary(
        self,
        result: dict[str, Any],
        member_reports: list[dict[str, Any]],
    ) -> tuple[str, dict[str, Any]]:
        snapshot = self.changes_snapshot()
        lead_text = " ".join(str(result.get("text") or "").split()).strip()
        lines = ["已停止当前回合。"]
        lines.append(
            "Lead 已完成："
            + (lead_text[:2_000] if lead_text else "当前动作边界前的工作，尚无额外文字结果。")
        )
        if member_reports:
            lines.append("成员执行情况：")
            for report in member_reports:
                name = str(report.get("name") or "成员")
                phase = str(report.get("phase") or "working")
                summary = " ".join(str(report.get("summary") or "").split()).strip()
                tool_name = str(report.get("tool_name") or "").strip()
                suffix = f"（{tool_name}）" if tool_name else ""
                lines.append(f"- {name}：已停止于 {phase}{suffix}；{summary}")
        else:
            lines.append("成员执行情况：停止时没有成员完成取消汇报。")
        reported_names = {str(report.get("name") or "") for report in member_reports}
        pending_members = sorted(
            set(self.cancel_requested_member_names) - reported_names
        )
        if pending_members:
            lines.append(
                "仍在当前动作边界内的成员："
                + "、".join(pending_members)
                + "（其取消报告将在动作返回后补发）。"
            )
        lines.append(
            "总体代码变更："
            f"{snapshot.get('total_files', 0)} 个文件，"
            f"+{snapshot.get('total_additions', 0)} "
            f"-{snapshot.get('total_deletions', 0)}。"
        )
        if snapshot.get("files"):
            lines.append("已触及文件：")
            for item in snapshot["files"][:8]:
                lines.append(
                    f"- {item.get('path', '')} +{item.get('additions', 0)} "
                    f"-{item.get('deletions', 0)}"
                )
            remaining = len(snapshot["files"]) - 8
            if remaining > 0:
                lines.append(f"- 另有 {remaining} 个文件未展开。")
        details = {
            "status": "cancelled",
            "members": member_reports,
            "pending_members": pending_members,
            "changes": snapshot,
        }
        return "\n".join(lines), details

    def _remember_tool_paths(self, payload: dict[str, Any]) -> None:
        input_data = payload.get("input")
        if not isinstance(input_data, dict):
            return
        raw_paths: set[str] = set()
        for key in ("path", "file_path", "filename"):
            value = input_data.get(key)
            if isinstance(value, str) and value.strip():
                raw_paths.add(value)
        for key in ("command", "cmd"):
            value = input_data.get(key)
            if isinstance(value, str):
                raw_paths.update(_command_file_paths(value))
        for raw_path in raw_paths:
            path = _normalize_git_path(raw_path).strip("'\"")
            if not path or path.startswith("-"):
                continue
            absolute = (self.workspace / Path(path)).resolve()
            try:
                relative = absolute.relative_to(self.workspace)
            except ValueError:
                continue
            normalized = _normalize_git_path(str(relative))
            if normalized not in self.turn_file_snapshots:
                self.turn_file_snapshots[normalized] = _file_snapshot(absolute)

        tool_use_id = str(payload.get("tool_use_id") or "").strip()
        if not tool_use_id:
            return
        for key in ("command", "cmd"):
            value = input_data.get(key)
            if not isinstance(value, str):
                continue
            operations = _command_file_operations(value)
            normalized_operations: dict[str, dict[str, Any]] = {}
            for raw_path, operation in operations.items():
                absolute = (self.workspace / Path(raw_path)).resolve()
                try:
                    normalized = _normalize_git_path(str(absolute.relative_to(self.workspace)))
                except ValueError:
                    continue
                operation = dict(operation)
                operation["was_missing"] = (
                    self.turn_file_snapshots.get(normalized, _FILE_MISSING) is _FILE_MISSING
                )
                normalized_operations[normalized] = operation
            if normalized_operations:
                self.turn_pending_file_ops[tool_use_id] = normalized_operations

    def _record_file_delta(self, payload: dict[str, Any] | None = None) -> None:
        current = _workspace_file_snapshots(self.workspace, set(self.turn_file_snapshots))
        for path in set(self.turn_file_snapshots) | set(current):
            previous = self.turn_file_snapshots.get(path, _FILE_MISSING)
            next_value = current.get(path, _FILE_MISSING)
            additions, deletions = _line_delta(previous, next_value)
            created = previous is _FILE_MISSING and next_value is not _FILE_MISSING
            deleted = previous is not _FILE_MISSING and next_value is _FILE_MISSING
            modified = (
                previous is not _FILE_MISSING
                and next_value is not _FILE_MISSING
                and (additions or deletions)
            )
            if additions or deletions or created or deleted or modified:
                delta = self.turn_file_ledger.setdefault(
                    path,
                    {
                        "additions": 0,
                        "deletions": 0,
                        "created": False,
                        "deleted": False,
                        "modified": False,
                        "diff_lines": [],
                    },
                )
                delta["additions"] += additions
                delta["deletions"] += deletions
                delta["created"] = bool(delta["created"] or created)
                delta["deleted"] = bool(delta["deleted"] or deleted)
                delta["modified"] = bool(delta["modified"] or modified)
                delta["diff_lines"] = (delta.get("diff_lines") or []) + _line_diff_lines(
                    previous, next_value
                )
        tool_use_id = str((payload or {}).get("tool_use_id") or "").strip()
        pending_operations = self.turn_pending_file_ops.pop(tool_use_id, {})
        output = str((payload or {}).get("output") or "")
        command_succeeded = not output.lstrip().lower().startswith("error:")
        for path, operation in pending_operations.items():
            if not command_succeeded or not operation.get("was_missing"):
                continue
            if not operation.get("created") or not operation.get("deleted"):
                continue
            if current.get(path, _FILE_MISSING) is not _FILE_MISSING:
                continue
            delta = self.turn_file_ledger.setdefault(
                path,
                {
                    "additions": 0,
                    "deletions": 0,
                    "created": False,
                    "deleted": False,
                    "modified": False,
                    "diff_lines": [],
                },
            )
            line_count = int(operation.get("created_lines") or 0)
            delta["additions"] += line_count
            delta["deletions"] += line_count
            delta["created"] = True
            delta["deleted"] = True
            content_lines = str(operation.get("created_content") or "").splitlines()
            delta["diff_lines"] = (delta.get("diff_lines") or []) + [
                {"kind": "deletion", "oldLine": index, "text": line}
                for index, line in enumerate(content_lines, start=1)
            ] + [
                {"kind": "addition", "newLine": index, "text": line}
                for index, line in enumerate(content_lines, start=1)
            ]
        self.turn_file_snapshots = current

    def revert_changes(self) -> dict[str, Any]:
        with self.turn_lock:
            if self.active_turn_id is not None:
                raise RuntimeError("Cannot revert changes while a turn is running")
            baseline_paths = self._baseline_for_snapshot()
            snapshot = self.changes_snapshot(include_protected=True)
            protected = sorted(
                item["path"] for item in snapshot["files"]
                if item["path"] in baseline_paths
            )
            targets = [
                item for item in snapshot["files"]
                if item["path"] not in baseline_paths
            ]
            tracked = [
                item["path"] for item in targets
                if item["status"] not in {"untracked", "created", "transient"}
            ]
            if tracked:
                code, _, error = _git_run(
                    self.workspace,
                    ["restore", "--worktree", "--staged", "--", *tracked],
                )
                if code != 0:
                    raise RuntimeError(error.strip() or "Unable to restore tracked changes")
            removed: list[str] = []
            for item in targets:
                if item["status"] not in {"untracked", "created"}:
                    continue
                path = (self.workspace / Path(item["path"])).resolve()
                try:
                    path.relative_to(self.workspace)
                    if path.is_file() or path.is_symlink():
                        path.unlink()
                        removed.append(item["path"])
                except (OSError, ValueError) as exc:
                    raise RuntimeError(f"Unable to remove untracked file {item['path']}: {exc}") from exc
            changes = self.changes_snapshot()
            self.turn_file_ledger.clear()
            self.turn_file_snapshots = {}
            self.turn_pending_file_ops.clear()
            self.manager.schedule_project_baseline_refresh(self.workspace)
            return {
                "status": "reverted",
                "reverted_paths": [item["path"] for item in targets],
                "removed_paths": removed,
                "protected_paths": protected,
                "changes": changes,
            }

    def review_changes(self) -> dict[str, Any]:
        snapshot = self.changes_snapshot()
        baseline_paths = self._baseline_for_snapshot()
        return {
            "status": "ready",
            "review_id": str(uuid.uuid4()),
            "changes": snapshot,
            "protected_paths": sorted(
                item["path"] for item in snapshot["files"]
                if item["path"] in baseline_paths
            ),
        }

    def publish(
        self,
        event_type: str,
        payload: dict[str, Any],
        turn_id: str | None = None,
    ) -> None:
        if turn_id and event_type in {"model.requested", "assistant.message"}:
            if event_type == "model.requested" or str(payload.get("phase") or "final") == "final":
                key = "model_requests" if event_type == "model.requested" else "replies"
                self.turn_lifecycle_counts[key] = self.turn_lifecycle_counts.get(key, 0) + 1
        if event_type == "turn.finished" and turn_id:
            payload = {
                **payload,
                "lifecycle_summary": {
                    "model_requests": self.turn_lifecycle_counts.get("model_requests", 0),
                    "replies": self.turn_lifecycle_counts.get("replies", 0),
                },
                # Persist the turn-local snapshot so historical answers can
                # render their own HUD without reading a later turn's state.
                "changes": self.changes_snapshot(),
            }
        elif event_type == "turn.error" and turn_id:
            payload = {**payload, "changes": self.changes_snapshot()}
        if event_type == "tool.requested":
            self._remember_tool_paths(payload)
        self.broker.publish(event_type, payload, turn_id)
        if event_type == "tool.result":
            self._record_file_delta(payload)

    def publish_team_event(
        self,
        event_type: str,
        payload: dict[str, Any],
        turn_id: str | None = None,
    ) -> None:
        """Receive structural events from the Buffeed runtime without blocking it."""
        lead_started = False
        lead_started_payload: dict[str, Any] | None = None
        try:
            data = dict(payload or {})
            run_id = str(data.get("run_id") or "").strip()
            with self.team_lock:
                active_execution_id = self.active_team_execution_id
                execution_id = self.team_run_execution_ids.get(run_id) if run_id else None
                if execution_id is None:
                    execution_id = active_execution_id or self.last_team_execution_id
                if execution_id is None:
                    execution_id = self.session_id
                if event_type == "run.plan":
                    raw_members = data.get("members", [])
                    if not isinstance(raw_members, list):
                        raw_members = []
                    lead_member: dict[str, Any] | None = None
                    for member in raw_members:
                        if isinstance(member, dict) and member.get("run_id"):
                            self.team_run_execution_ids[str(member["run_id"])] = execution_id
                            if str(member.get("run_id")) == "lead" or str(member.get("name")) == "lead":
                                lead_member = member
                    if run_id:
                        self.team_run_execution_ids[run_id] = execution_id
                    # ``run.plan`` is the Team boundary; older producers may
                    # omit the lead from ``members``.  Keep the original plan
                    # untouched, but still persist a complete lead lifecycle.
                    self.team_plan_executions.add(execution_id)
                    task_id = lead_member.get("task_id") if lead_member else None
                    if not task_id:
                        raw_tasks = data.get("tasks", [])
                        if isinstance(raw_tasks, list):
                            task_id = next(
                                (
                                    task.get("task_id") or task.get("id")
                                    for task in raw_tasks
                                    if isinstance(task, dict)
                                    and task.get("owner") in {"lead", "agent"}
                                ),
                                None,
                            )
                    self.team_lead_task_ids[execution_id] = str(task_id) if task_id else None
                    if execution_id not in self.team_lead_started:
                        self.team_lead_started.add(execution_id)
                        lead_started = True
                        lead_started_payload = {
                            "run_id": "lead",
                            "name": "lead",
                            "role": "lead",
                            "task_id": self.team_lead_task_ids[execution_id],
                        }
                elif run_id:
                    self.team_run_execution_ids[run_id] = execution_id
                if execution_id in self.team_plan_executions:
                    previous_execution_id = self.last_team_execution_id
                    previous_started_at = self.team_execution_started_at.get(
                        previous_execution_id or "", 0.0
                    )
                    current_started_at = self.team_execution_started_at.get(
                        execution_id, 0.0
                    )
                    if (
                        previous_execution_id is None
                        or execution_id == active_execution_id
                        or current_started_at >= previous_started_at
                    ):
                        self.last_team_execution_id = execution_id
                event_turn_id = turn_id or self.team_execution_turn_ids.get(execution_id)
            self.team_journal.append(
                event_type,
                data,
                turn_id=event_turn_id or self.active_turn_id,
                execution_id=execution_id,
            )
            if lead_started and lead_started_payload is not None:
                self.team_journal.append(
                    "run.started",
                    lead_started_payload,
                    turn_id=event_turn_id or self.active_turn_id,
                    execution_id=execution_id,
                )
        except Exception:
            # The runtime's observer boundary must not terminate a Team thread.
            return

    def publish_lead_progress(
        self,
        event_type: str,
        payload: dict[str, Any],
        turn_id: str | None = None,
    ) -> None:
        """Mirror lead model/tool phases only after a real Team plan exists."""
        phase_by_event = {
            "model.requested": "model.requested",
            "assistant.message": "model.responded",
            "tool.requested": "tool.requested",
            "tool.result": "tool.completed",
        }
        phase = phase_by_event.get(event_type)
        if phase is None:
            return
        with self.team_lock:
            execution_id = self.active_team_execution_id
            if execution_id not in self.team_plan_executions:
                return
            if execution_id in self.team_lead_finished:
                return
            task_id = self.team_lead_task_ids.get(execution_id)
            event_turn_id = turn_id or self.team_execution_turn_ids.get(execution_id)
        progress: dict[str, Any] = {
            "run_id": "lead",
            "name": "lead",
            "role": "lead",
            "task_id": task_id,
            "phase": phase,
            "summary": (
                str(payload.get("tool_name") or "")
                if phase in {"tool.requested", "tool.completed"}
                else "Lead model activity"
            ),
        }
        if payload.get("tool_name"):
            progress["tool_name"] = str(payload["tool_name"])
        try:
            self.team_journal.append(
                "run.progress",
                progress,
                turn_id=event_turn_id or self.active_turn_id,
                execution_id=execution_id,
            )
        except Exception:
            return

    def finish_lead_team_run(
        self,
        status: str,
        *,
        turn_id: str | None,
        error: Exception | None = None,
    ) -> None:
        """Persist one terminal lead event for executions that declared a Team."""
        with self.team_lock:
            execution_id = self.active_team_execution_id
            if execution_id not in self.team_plan_executions:
                return
            if execution_id in self.team_lead_finished:
                return
            self.team_lead_finished.add(execution_id)
            task_id = self.team_lead_task_ids.get(execution_id)
            event_turn_id = turn_id or self.team_execution_turn_ids.get(execution_id)
            started_at = self.team_execution_started_at.get(execution_id)
        if status in {"error", "cancelled"} or error is not None:
            payload = {
                "run_id": "lead",
                "name": "lead",
                "role": "lead",
                "task_id": task_id,
                "error_code": "cancelled" if status == "cancelled" else type(error).__name__ if error else "turn_error",
                "message": "Lead turn cancelled" if status == "cancelled" else str(error or "Lead turn failed"),
            }
            event_type = "run.failed"
        else:
            payload = {
                "run_id": "lead",
                "name": "lead",
                "role": "lead",
                "task_id": task_id,
                "duration_ms": max(0, int((time.monotonic() - started_at) * 1000)) if started_at else 0,
            }
            event_type = "run.completed"
        try:
            self.team_journal.append(
                event_type,
                payload,
                turn_id=event_turn_id or self.active_turn_id,
                execution_id=execution_id,
            )
        except Exception:
            return

    def _schedule_baseline_refresh(self) -> None:
        self.manager.schedule_project_baseline_refresh(self.workspace)

    def deliver_turn(self, query: str, delivery: Literal["queue", "steer"]) -> dict[str, Any]:
        if delivery == "steer":
            with self.turn_lock:
                if self.active_turn_id is not None:
                    return self._accept_steer_locked(query, self.active_turn_id)
        turn_id, status = self.submit_turn(query)
        return {"turn_id": turn_id, "status": status}

    def _accept_steer_locked(self, query: str, turn_id: str) -> dict[str, Any]:
        if self.approvals.has_pending(turn_id):
            raise RuntimeError("当前回合正在等待审批，暂时无法插入消息")
        with self.steer_lock:
            if len(self.pending_steers) >= MAX_PENDING_STEERS:
                raise RuntimeError("当前回合的追加消息已达到上限")
            interjection_id = str(uuid.uuid4())
            self.pending_steers.append(
                {
                    "interjection_id": interjection_id,
                    "turn_id": turn_id,
                    "text": query,
                }
            )
        self.publish(
            "user_interjection",
            {
                "interjection_id": interjection_id,
                "status": "received",
                "content": query,
                "delivery": "steer",
                "confirm_reason": "steer_confirm",
            },
            turn_id,
        )
        return {
            "turn_id": turn_id,
            "status": "received",
            "interjection_id": interjection_id,
        }

    def _drain_steers(self, turn_id: str) -> list[dict[str, Any]]:
        with self.steer_lock:
            selected: list[dict[str, Any]] = []
            remaining: deque[dict[str, Any]] = deque()
            while self.pending_steers:
                item = self.pending_steers.popleft()
                if item.get("turn_id") == turn_id:
                    selected.append(item)
                else:
                    remaining.append(item)
            self.pending_steers = remaining
            return selected

    def _fail_pending_steers(self, turn_id: str, reason: str) -> None:
        for item in self._drain_steers(turn_id):
            self.publish(
                "user_interjection",
                {
                    "interjection_id": item["interjection_id"],
                    "status": "failed",
                    "reason": reason,
                },
                turn_id,
            )

    def _enqueue_steer_fallback(
        self,
        turn_id: str,
        items: list[dict[str, Any]],
    ) -> None:
        for item in items:
            query = str(item.get("text") or "").strip()
            interjection_id = str(item.get("interjection_id") or "").strip()
            if not query or not interjection_id:
                continue
            with self.turn_lock:
                if len(self.queued_turns) >= MAX_QUEUED_TURNS:
                    self.publish(
                        "user_interjection",
                        {
                            "interjection_id": interjection_id,
                            "status": "failed",
                            "reason": "queue_full",
                        },
                        turn_id,
                    )
                    continue
                queue_turn_id = str(uuid.uuid4())
                position = len(self.queued_turns) + 1
                self.manager.store.create_turn(
                    queue_turn_id,
                    self.session_id,
                    query,
                    status="queued",
                )
                self.manager.store.set_session_status(self.session_id, "running")
                self.queued_turns.append((queue_turn_id, query, [], "system"))
            self.publish(
                "user_interjection",
                {
                    "interjection_id": interjection_id,
                    "status": "queued",
                    "queue_turn_id": queue_turn_id,
                    "degraded_from": "steer",
                },
                turn_id,
            )
            self.publish(
                "turn.queued",
                {
                    "query": query,
                    "position": position,
                    "mode": "queue",
                    "interjection_id": interjection_id,
                    "degraded_from": "steer",
                },
                queue_turn_id,
            )

    def submit_turn(self, query: str, attachments: list[dict[str, Any]] | None = None, model: str = "system") -> tuple[str, str]:
        """Persist a message immediately, then run it or enqueue it FIFO."""
        turn_id = str(uuid.uuid4())
        with self.turn_lock:
            if self.active_turn_id is not None:
                if len(self.queued_turns) >= MAX_QUEUED_TURNS:
                    raise RuntimeError("Too many queued turns for this session")
                self.manager.store.create_turn(
                    turn_id,
                    self.session_id,
                    query,
                    status="queued",
                    attachments=attachments,
                    model=model,
                )
                self.manager.store.set_session_status(self.session_id, "running")
                self.queued_turns.append((turn_id, query, attachments or [], model))
                self.publish(
                    "turn.queued",
                    {
                        "query": query,
                        "position": len(self.queued_turns),
                        "mode": "queue",
                    },
                    turn_id,
                )
                return turn_id, "queued"

            self.manager.store.create_turn(
                turn_id,
                self.session_id,
                query,
                status="running",
                attachments=attachments,
                model=model,
            )
            self._start_turn_locked(turn_id, query, attachments or [], model)
            return turn_id, "running"

    def start_turn(self, query: str) -> str:
        """Compatibility wrapper for callers that only need the turn id."""
        turn_id, _ = self.submit_turn(query)
        return turn_id

    def _start_turn_locked(
        self, turn_id: str, query: str, attachments: list[dict[str, Any]] | None = None, model: str = "system"
    ) -> None:
        suspend_members = getattr(self.Buffeed, "cancel_active_teammates", None)
        if callable(suspend_members):
            suspend_members("new_turn")
        self.baseline_paths = self.manager.project_baseline_paths(self.workspace)
        self.turn_file_snapshots = {}
        self.turn_file_ledger.clear()
        self.turn_pending_file_ops.clear()
        self.turn_lifecycle_counts.clear()
        self.cancel_requested_member_names.clear()
        self.active_turn_id = turn_id
        with self.team_lock:
            execution_id = f"turn:{turn_id}"
            self.active_team_execution_id = execution_id
            self.team_execution_turn_ids[execution_id] = turn_id
            self.team_execution_started_at[execution_id] = time.monotonic()
        begin_team_execution = getattr(self.Buffeed, "begin_team_execution", None)
        if callable(begin_team_execution):
            begin_team_execution()
        self.cancel_event.clear()
        self.manager.store.mark_turn_running(turn_id)
        self.manager.store.set_session_status(self.session_id, "running")
        self.turn_thread = threading.Thread(
            target=self._run_turn,
            args=(turn_id, query, attachments or [], model),
            name=f"desktop-turn-{self.session_id[:8]}",
            daemon=True,
        )
        self.turn_thread.start()

    def resume_queued_turns(self) -> None:
        """Recover durable queued messages after a runtime is restored."""
        with self.turn_lock:
            known = {turn_id for turn_id, _, _, _ in self.queued_turns}
            for item in self.manager.store.queued_turns(self.session_id):
                turn_id = str(item["turn_id"])
                if turn_id not in known:
                    self.queued_turns.append((turn_id, str(item["query"]), list(item.get("attachments") or []), str(item.get("model") or "system")))
                    known.add(turn_id)
            if self.active_turn_id is None and self.queued_turns:
                turn_id, query, attachments, model = self.queued_turns.popleft()
                self._start_turn_locked(turn_id, query, attachments, model)

    def _run_turn(self, turn_id: str, query: str, attachments: list[dict[str, Any]], model: str) -> None:
        def emit(event_type: str, payload: dict[str, Any]) -> None:
            self.publish(event_type, payload, turn_id)
            self.publish_lead_progress(event_type, payload, turn_id)

        turn_status = "error"
        try:
            effective_model = resolve_turn_model(model)
            result = self.agent_session.run_turn(
                query,
                attachments=attachments,
                model=effective_model,
                event_sink=emit,
                approval_resolver=lambda block: self.approvals.request(block, turn_id),
                is_cancelled=self.cancel_event.is_set,
                interjection_provider=lambda: self._drain_steers(turn_id),
                interjection_fallback=lambda items: self._enqueue_steer_fallback(turn_id, items),
                allow_background=False,
            )
            turn_status = str(result.get("status", "completed"))
            cancellation_details: dict[str, Any] | None = None
            if turn_status == "cancelled":
                member_reports = self._await_team_cancellation_reports(
                    list(self.cancel_requested_member_names)
                )
                self._record_file_delta()
                stop_summary, cancellation_details = self._build_cancellation_summary(
                    result,
                    member_reports,
                )
                result = {
                    **result,
                    "text": stop_summary,
                    "cancellation": cancellation_details,
                }
                self.publish(
                    "assistant.message",
                    {
                        "text": stop_summary,
                        "phase": "final",
                        "cancellation": cancellation_details,
                    },
                    turn_id,
                )
            self.manager.store.set_turn_status(turn_id, turn_status)
            self.finish_lead_team_run(turn_status, turn_id=turn_id)
            suspend_members = getattr(self.Buffeed, "cancel_active_teammates", None)
            if callable(suspend_members):
                suspend_members("turn_finished")
            # Make the final changes snapshot visible before the renderer reacts to turn.finished.
            self._record_file_delta()
            self.publish("turn.finished", result, turn_id)
        except Exception as exc:
            turn_status = "error"
            self.manager.store.set_turn_status(turn_id, "error")
            self.finish_lead_team_run("error", turn_id=turn_id, error=exc)
            suspend_members = getattr(self.Buffeed, "cancel_active_teammates", None)
            if callable(suspend_members):
                suspend_members("turn_error")
            self._record_file_delta()
            self.publish(
                "turn.error",
                {"error_type": type(exc).__name__, "message": str(exc)},
                turn_id,
            )
        finally:
            if turn_status in {"cancelled", "error"}:
                self._fail_pending_steers(turn_id, turn_status)
            else:
                self._enqueue_steer_fallback(turn_id, self._drain_steers(turn_id))
            self._record_file_delta()
            with self.turn_lock:
                self.active_turn_id = None
                self.turn_thread = None
                with self.team_lock:
                    self.active_team_execution_id = None
                self.cancel_requested_member_names.clear()
                next_turn = self.queued_turns.popleft() if self.queued_turns else None
                if next_turn is not None:
                    self._start_turn_locked(*next_turn)
                else:
                    self.manager.store.set_session_status(self.session_id, "idle")
                    end_team_execution = getattr(self.Buffeed, "end_team_execution", None)
                    if callable(end_team_execution):
                        end_team_execution()
            if next_turn is None:
                self._schedule_baseline_refresh()

    def cancel_turn(self, turn_id: str) -> bool:
        queued = False
        with self.turn_lock:
            if self.active_turn_id == turn_id:
                self.cancel_event.set()
            else:
                for index, queued_item in enumerate(self.queued_turns):
                    if queued_item[0] == turn_id:
                        del self.queued_turns[index]
                        queued = True
                        break
                if not queued:
                    return False
        if queued:
            self.manager.store.set_turn_status(turn_id, "cancelled")
            if self.active_turn_id is None and not self.queued_turns:
                self.manager.store.set_session_status(self.session_id, "idle")
            self.publish(
                "turn.cancel.requested",
                {"queued": True, "team_members": []},
                turn_id,
            )
            self.publish(
                "turn.cancelled",
                {"status": "cancelled", "queued": True},
                turn_id,
            )
            return True
        cancel_active_teammates = getattr(self.Buffeed, "cancel_active_teammates", None)
        team_members = (
            cancel_active_teammates("lead_cancelled")
            if callable(cancel_active_teammates)
            else []
        )
        with self.turn_lock:
            self.cancel_requested_member_names = list(team_members)
        self.approvals.cancel_all()
        self.publish(
            "turn.cancel.requested",
            {"turn_id": turn_id, "team_members": team_members},
            turn_id,
        )
        return True

    def team_execution_id(self, events: list[dict[str, Any]]) -> str:
        with self.team_lock:
            preferred = self.active_team_execution_id or self.last_team_execution_id
        if preferred:
            return preferred
        for event in reversed(events):
            payload = event.get("payload")
            if isinstance(payload, dict) and str(payload.get("execution_id") or "").strip():
                return str(payload["execution_id"])
        return self.session_id

    def hydrate_team_executions(self) -> None:
        """Rebuild durable Team execution indexes after a cold runtime restore."""
        events = self.manager.store.events_after(self.session_id, 0)
        plans = [
            event for event in events
            if event.get("event_type") == "run.plan"
            and isinstance(event.get("payload"), dict)
            and str(event["payload"].get("execution_id") or "").strip()
        ]
        with self.team_lock:
            for event in plans:
                payload = event["payload"]
                execution_id = str(payload["execution_id"])
                self.team_plan_executions.add(execution_id)
                self.team_execution_turn_ids.setdefault(execution_id, event.get("turn_id"))
                created_at = event.get("created_at")
                if isinstance(created_at, (int, float)):
                    self.team_execution_started_at.setdefault(execution_id, float(created_at))
                run_id = str(payload.get("run_id") or "").strip()
                if run_id:
                    self.team_run_execution_ids[run_id] = execution_id
                members = payload.get("members")
                if isinstance(members, list):
                    for member in members:
                        if isinstance(member, dict) and member.get("run_id"):
                            self.team_run_execution_ids[str(member["run_id"])] = execution_id
                self.last_team_execution_id = execution_id

    @staticmethod
    def events_for_execution(
        events: list[dict[str, Any]], execution_id: str
    ) -> list[dict[str, Any]]:
        return [
            event
            for event in events
            if isinstance(event.get("payload"), dict)
            and event["payload"].get("execution_id") == execution_id
        ]


class DesktopManager:
    def __init__(self, store: DesktopStore) -> None:
        self.store = store
        self._sessions: dict[str, SessionRuntime] = {}
        self._session_access: dict[str, float] = {}
        self._lock = threading.Lock()
        self._module_load_lock = threading.Lock()
        self._project_baselines: dict[str, set[str]] = {}
        self._project_baseline_locks: dict[str, threading.Lock] = {}
        self._project_baseline_refreshing: set[str] = set()
        self._runtime_restore_threads: dict[str, threading.Thread] = {}
        self._runtime_restore_errors: dict[str, str] = {}
        self._turn_dispatch_threads: dict[str, threading.Thread] = {}
        self._turn_dispatch_requested: set[str] = set()
        self._full_history_targets: set[str] = set()

    @staticmethod
    def _project_key(workspace: Path) -> str:
        return os.path.normcase(str(workspace.expanduser().resolve()))

    def _project_baseline_lock(self, key: str) -> threading.Lock:
        with self._lock:
            lock = self._project_baseline_locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._project_baseline_locks[key] = lock
            return lock

    def project_baseline_paths(self, workspace: Path) -> set[str]:
        """Return one cached Git baseline shared by all sessions in a project."""
        started_at = time.perf_counter()
        root = workspace.expanduser().resolve()
        key = self._project_key(root)
        with self._lock:
            cached = self._project_baselines.get(key)
        if cached is not None:
            _log_timing(
                "git.baseline.cache_hit",
                started_at,
                project_id=key,
                paths=len(cached),
            )
            return set(cached)

        lock = self._project_baseline_lock(key)
        with lock:
            with self._lock:
                cached = self._project_baselines.get(key)
            if cached is None:
                paths = _git_status_paths(root)
                with self._lock:
                    self._project_baselines[key] = set(paths)
                _log_timing(
                    "git.baseline.initial_scan",
                    started_at,
                    project_id=key,
                    paths=len(paths),
                )
                return set(paths)
        _log_timing(
            "git.baseline.cache_wait",
            started_at,
            project_id=key,
            paths=len(cached or ()),
        )
        return set(cached or ())

    def _project_has_active_turn(self, key: str) -> bool:
        with self._lock:
            return any(
                self._project_key(runtime.workspace) == key
                and runtime.active_turn_id is not None
                for runtime in self._sessions.values()
            )

    def _refresh_project_baseline(self, workspace: Path) -> None:
        started_at = time.perf_counter()
        root = workspace.expanduser().resolve()
        key = self._project_key(root)
        if self._project_has_active_turn(key):
            return
        lock = self._project_baseline_lock(key)
        with lock:
            if self._project_has_active_turn(key):
                return
            paths = _git_status_paths(root)
            with self._lock:
                self._project_baselines[key] = set(paths)
        _log_timing(
            "git.baseline.async_refresh",
            started_at,
            project_id=key,
            paths=len(paths),
        )

    def schedule_project_baseline_refresh(self, workspace: Path) -> None:
        root = workspace.expanduser().resolve()
        key = self._project_key(root)
        with self._lock:
            if key in self._project_baseline_refreshing:
                return
            self._project_baseline_refreshing.add(key)

        def refresh() -> None:
            try:
                self._refresh_project_baseline(root)
            finally:
                with self._lock:
                    self._project_baseline_refreshing.discard(key)

        threading.Thread(
            target=refresh,
            name=f"desktop-project-git-{abs(hash(key)) % 100000:05d}",
            daemon=True,
        ).start()

    def get_cached_runtime(self, session_id: str) -> SessionRuntime | None:
        with self._lock:
            runtime = self._sessions.get(session_id)
            if runtime is not None:
                self._session_access[session_id] = time.monotonic()
            return runtime

    def runtime_status(self, session_id: str) -> str:
        with self._lock:
            if session_id in self._sessions:
                return "ready"
            thread = self._runtime_restore_threads.get(session_id)
            if thread is not None and thread.is_alive():
                return "restoring"
            if session_id in self._runtime_restore_errors:
                return "error"
        return "cold"

    def history_mode(self, session_id: str) -> str:
        with self._lock:
            return "full" if session_id in self._full_history_targets else "window"

    def warm_session(self, session_id: str) -> str:
        status = self.runtime_status(session_id)
        if status in {"ready", "restoring"}:
            return status
        with self._lock:
            existing = self._runtime_restore_threads.get(session_id)
            if existing is not None and existing.is_alive():
                return "restoring"
            self._runtime_restore_errors.pop(session_id, None)

            def restore() -> None:
                started_at = time.perf_counter()
                try:
                    self.get_session(session_id)
                    _log_timing(
                        "runtime.restore",
                        started_at,
                        session_id=session_id,
                        status="ready",
                    )
                except Exception as exc:
                    with self._lock:
                        self._runtime_restore_errors[session_id] = type(exc).__name__
                    _log_timing(
                        "runtime.restore",
                        started_at,
                        session_id=session_id,
                        status="error",
                        error_type=type(exc).__name__,
                    )
                finally:
                    with self._lock:
                        self._runtime_restore_threads.pop(session_id, None)

            thread = threading.Thread(
                target=restore,
                name=f"desktop-runtime-restore-{session_id[:8]}",
                daemon=True,
            )
            self._runtime_restore_threads[session_id] = thread
            thread.start()
            return "restoring"

    def prewarm_recent_sessions(self) -> None:
        """Restore the sessions most likely to receive the next desktop request."""
        if WARM_SESSION_COUNT == 0:
            with self._lock:
                self._full_history_targets.clear()
            return

        sessions = self.store.list_sessions()
        prioritized = sorted(
            sessions,
            key=lambda session: (
                0 if str(session.get("status")) == "running" else 1,
                -float(session.get("updated_at") or 0),
            ),
        )[:WARM_SESSION_COUNT]
        with self._lock:
            self._full_history_targets = {
                str(session["session_id"])
                for session in prioritized
            }

        def prewarm() -> None:
            for session in prioritized:
                session_id = str(session["session_id"])
                try:
                    # Hot sessions keep a folded full-history cache so the
                    # renderer can restore every historical turn immediately.
                    self.store.history_events_after(session_id, 0, summary=True)
                    self.warm_session(session_id)
                except Exception as exc:
                    LOGGER.warning(
                        "session prewarm failed", extra={"session_id": session_id, "error": type(exc).__name__}
                    )

        threading.Thread(
            target=prewarm,
            name="desktop-runtime-prewarm",
            daemon=True,
        ).start()

    def schedule_turn_dispatch(self, session_id: str) -> None:
        """Start durable queued turns outside the request that accepted them."""
        with self._lock:
            self._turn_dispatch_requested.add(session_id)
            existing = self._turn_dispatch_threads.get(session_id)
            if existing is not None and existing.is_alive():
                return

            def dispatch() -> None:
                while True:
                    with self._lock:
                        self._turn_dispatch_requested.discard(session_id)
                    try:
                        runtime = self.get_session(session_id)
                        runtime.resume_queued_turns()
                    except Exception as exc:
                        LOGGER.warning(
                            "turn dispatch failed", extra={"session_id": session_id, "error": type(exc).__name__}
                        )
                    with self._lock:
                        if session_id in self._turn_dispatch_requested:
                            continue
                        self._turn_dispatch_threads.pop(session_id, None)
                        return

            thread = threading.Thread(
                target=dispatch,
                name=f"desktop-turn-dispatch-{session_id[:8]}",
                daemon=True,
            )
            self._turn_dispatch_threads[session_id] = thread
            thread.start()

    @staticmethod
    def _shutdown_runtime(runtime: SessionRuntime) -> None:
        runtime.cancel_event.set()
        runtime.approvals.cancel_all()
        try:
            runtime.Buffeed.shutdown_mcp_clients()
        except Exception:
            pass

    def _cache_runtime(self, session_id: str, runtime: SessionRuntime) -> None:
        evicted: list[SessionRuntime] = []
        with self._lock:
            self._sessions[session_id] = runtime
            self._session_access[session_id] = time.monotonic()
            while len(self._sessions) > MAX_RUNTIME_SESSIONS:
                candidates = [
                    (self._session_access.get(candidate_id, 0.0), candidate_id)
                    for candidate_id, candidate_runtime in self._sessions.items()
                    if (
                        candidate_id != session_id
                        and candidate_runtime.active_turn_id is None
                        and not candidate_runtime.queued_turns
                    )
                ]
                if not candidates:
                    break
                _, stale_id = min(candidates)
                stale_runtime = self._sessions.pop(stale_id)
                self._session_access.pop(stale_id, None)
                evicted.append(stale_runtime)
        for stale_runtime in evicted:
            self._shutdown_runtime(stale_runtime)
        runtime.resume_queued_turns()

    def submit_turn(
        self,
        session_id: str,
        query: str,
        attachments: list[dict[str, Any]] | None = None,
        request_id: str | None = None,
        model: str = "system",
    ) -> dict[str, Any]:
        """Durably queue a turn before any runtime lock, restore or model work."""
        session = self.store.get_session(session_id)
        if session is None:
            raise KeyError(session_id)
        effective_model = resolve_turn_model(model)
        normalized_attachments = self._normalize_attachments(
            Path(str(session["workspace"])), attachments or []
        )
        result = self.store.enqueue_turn(
            request_id or str(uuid.uuid4()),
            session_id,
            query,
            max_queued_turns=MAX_QUEUED_TURNS,
            attachments=normalized_attachments,
            model=effective_model,
        )
        runtime = self.get_cached_runtime(session_id)
        if runtime is not None:
            runtime.broker.wake()
        if result["created"] or result["status"] == "queued":
            self.schedule_turn_dispatch(session_id)
        return {
            "turn_id": result["turn_id"],
            "status": result["status"],
            "title": result["title"],
        }

    @staticmethod
    def _normalize_attachments(
        workspace: Path, attachments: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        if len(attachments) > MAX_TURN_ATTACHMENTS:
            raise ValueError(f"附件数量不能超过 {MAX_TURN_ATTACHMENTS} 个")
        root = workspace.expanduser().resolve()
        normalized: list[dict[str, Any]] = []
        for item in attachments:
            if not isinstance(item, dict):
                raise ValueError("附件格式无效")
            kind = str(item.get("kind") or "file").lower()
            if kind not in {"file", "folder", "image", "video", "audio", "history"}:
                raise ValueError("不支持的附件类型")
            path_value = str(item.get("path") or "").strip()
            clean: dict[str, Any] = {
                "name": str(item.get("name") or "附件")[:256],
                "kind": kind,
                "mime_type": str(item.get("mime_type") or item.get("mimeType") or "")[:128],
            }
            if item.get("context"):
                clean["context"] = str(item["context"])[:30_000]
            preview_url = str(item.get("preview_url") or item.get("previewUrl") or "").strip()
            if (
                preview_url
                and len(preview_url) <= MAX_ATTACHMENT_PREVIEW_URL_CHARS
                and re.fullmatch(r"data:image/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+", preview_url)
            ):
                clean["preview_url"] = preview_url
            if path_value:
                candidate = Path(path_value).expanduser()
                if not candidate.is_absolute():
                    candidate = root / candidate
                try:
                    resolved = candidate.resolve(strict=True)
                    resolved.relative_to(root)
                except (OSError, ValueError) as exc:
                    raise ValueError("附件必须位于当前工作区内") from exc
                if not resolved.is_file():
                    raise ValueError("仅支持引入普通文件")
                size = resolved.stat().st_size
                if size > MAX_ATTACHMENT_BYTES:
                    raise ValueError("附件不能超过 100 MB")
                mime_type = clean["mime_type"] or mimetypes.guess_type(resolved.name)[0] or "application/octet-stream"
                clean.update({"path": str(resolved), "mime_type": mime_type})
                if kind == "image" or mime_type.startswith("image/"):
                    if mime_type not in {"image/jpeg", "image/png", "image/gif", "image/webp"} or size > MAX_INLINE_IMAGE_BYTES:
                        raise ValueError("图片必须是受支持的格式且不超过 20 MB")
                    clean["kind"] = "image"
                elif mime_type.startswith("video/"):
                    clean["kind"] = "video"
                elif mime_type.startswith("audio/"):
                    clean["kind"] = "audio"
            elif kind != "history":
                raise ValueError("附件缺少文件路径")
            normalized.append(clean)
        return normalized

    def deliver_turn(
        self,
        session_id: str,
        query: str,
        delivery: Literal["queue", "steer"],
        attachments: list[dict[str, Any]] | None = None,
        request_id: str | None = None,
        model: str = "system",
    ) -> dict[str, Any]:
        runtime = self.get_cached_runtime(session_id)
        if delivery == "steer" and runtime is not None:
            return runtime.deliver_turn(query, delivery)
        return self.submit_turn(session_id, query, attachments, request_id, model)

    def cancel_turn(self, session_id: str, turn_id: str) -> bool:
        runtime = self.get_cached_runtime(session_id)
        if runtime is not None and runtime.cancel_turn(turn_id):
            return True
        if (
            self.store.turn_session_id(turn_id) != session_id
            or self.store.turn_status(turn_id) != "queued"
        ):
            return False
        self.store.set_turn_status(turn_id, "cancelled")
        self.store.append_event(
            session_id,
            turn_id,
            "turn.cancel.requested",
            {"queued": True, "team_members": []},
        )
        self.store.append_event(
            session_id,
            turn_id,
            "turn.cancelled",
            {"status": "cancelled", "queued": True},
        )
        if not self.store.queued_turns(session_id):
            self.store.set_session_status(session_id, "idle")
        return True

    def create_session(self, workspace: str) -> SessionRuntime:
        root = Path(workspace).expanduser().resolve()
        if not root.is_dir():
            raise ValueError("workspace must be an existing directory")
        session_id = str(uuid.uuid4())
        runtime = self._create_runtime(session_id, root)
        self.store.create_session(session_id, root)
        self._cache_runtime(session_id, runtime)
        runtime.publish("session.created", {"workspace": str(root)})
        return runtime

    def get_session(self, session_id: str) -> SessionRuntime:
        with self._lock:
            runtime = self._sessions.get(session_id)
            if runtime is not None:
                self._session_access[session_id] = time.monotonic()
            restore_thread = self._runtime_restore_threads.get(session_id)
        if runtime is not None:
            return runtime
        if restore_thread is not None and restore_thread is not threading.current_thread():
            restore_thread.join()
            with self._lock:
                runtime = self._sessions.get(session_id)
                if runtime is not None:
                    self._session_access[session_id] = time.monotonic()
            if runtime is not None:
                return runtime

        session = self.store.get_session(session_id)
        if session is None:
            raise KeyError(session_id)
        root = Path(str(session["workspace"])).expanduser().resolve()
        if not root.is_dir():
            raise ValueError("workspace for this session no longer exists")

        restored = self._create_runtime(session_id, root)
        with self._lock:
            runtime = self._sessions.get(session_id)
            if runtime is None:
                self._sessions[session_id] = restored
                self._session_access[session_id] = time.monotonic()
                runtime = restored
            else:
                self._session_access[session_id] = time.monotonic()
        if runtime is restored:
            self._cache_runtime(session_id, restored)
            return restored
        try:
            self._shutdown_runtime(restored)
        except Exception:
            pass
        return runtime

    def _create_runtime(self, session_id: str, root: Path) -> SessionRuntime:
        started_at = time.perf_counter()
        try:
            Buffeed = self._load_Buffeed_runtime(root, session_id)
            rag_connect_started = time.perf_counter()
            ensure_rag = getattr(Buffeed, "ensure_rag_mcp_connected", None)
            rag_status = (
                ensure_rag()
                if callable(ensure_rag)
                else "RAG auto-connect is not supported by this runtime"
            )
            _log_timing(
                "runtime.rag_autoconnect",
                rag_connect_started,
                session_id=session_id,
                project_id=self._project_key(root),
                status=rag_status[:160],
            )
            if not rag_status.startswith(("Connected", "MCP server")):
                LOGGER.info(
                    "local RAG is not ready; agent will continue without it",
                    extra={"session_id": session_id, "status": rag_status},
                )
            session_init_started = time.perf_counter()
            agent_session = Buffeed.AgentSession(DESKTOP_DISABLED_TOOLS)
            _log_timing(
                "runtime.agent_session_init",
                session_init_started,
                session_id=session_id,
                project_id=self._project_key(root),
            )
        except KeyError as exc:
            raise ValueError("MODEL_ID must be configured before creating a session") from exc
        runtime = SessionRuntime(
            manager=self,
            session_id=session_id,
            workspace=root,
            Buffeed=Buffeed,
            agent_session=agent_session,
            broker=EventBroker(store=self.store, session_id=session_id),
        )
        runtime.hydrate_team_executions()
        hydrate_team_task_results = getattr(Buffeed, "hydrate_team_task_results", None)
        if callable(hydrate_team_task_results):
            hydrate_team_task_results(self.store.events_after(session_id, 0))
        self._hydrate_agent_session(session_id, agent_session)
        set_team_event_sink = getattr(Buffeed, "set_team_event_sink", None)
        if callable(set_team_event_sink):
            set_team_event_sink(runtime.publish_team_event)
        _log_timing(
            "runtime.create",
            started_at,
            session_id=session_id,
            project_id=self._project_key(root),
        )
        return runtime

    def _hydrate_agent_session(self, session_id: str, agent_session: Any) -> None:
        started_at = time.perf_counter()
        messages: list[dict[str, Any]] = []
        events = self.store.conversation_events(session_id)
        video_analysis_by_turn = {
            str(event.get("turn_id") or ""): str(
                (event.get("payload") or {}).get("analysis") or ""
            ).strip()
            for event in events
            if event.get("event_type") == "video.analysis"
            and str(event.get("turn_id") or "")
        }
        for event in events:
            payload = event.get("payload")
            if not isinstance(payload, dict):
                continue
            if event["event_type"] == "turn.started":
                query = str(payload.get("query") or "").strip()
                if query:
                    attachments = payload.get("attachments")
                    build_content = getattr(agent_session, "build_turn_content", None)
                    build_video_handoff = getattr(agent_session, "build_video_agent_content", None)
                    turn_id = str(event.get("turn_id") or "")
                    has_video = (
                        isinstance(attachments, list)
                        and any(str(item.get("kind") or "") == "video" for item in attachments if isinstance(item, dict))
                    )
                    if has_video and callable(build_video_handoff):
                        analysis = video_analysis_by_turn.get(turn_id, "")
                        content = build_video_handoff(
                            query,
                            analysis or "该历史回合的视频分析结果不可用，请不要重新注入或读取原始视频。",
                            attachments,
                        )
                    else:
                        content = (
                            build_content(query, attachments, model=str(payload.get("model") or "system"))
                            if callable(build_content) and isinstance(attachments, list)
                            else query
                        )
                    messages.append({"role": "user", "content": content})
            elif event["event_type"] == "assistant.message":
                text = str(payload.get("text") or "").strip()
                if text:
                    messages.append({"role": "assistant", "content": text})
        if messages:
            agent_session.messages = messages
        _log_timing(
            "runtime.history_hydrate",
            started_at,
            session_id=session_id,
            message_count=len(messages),
        )

    def _load_Buffeed_runtime(self, workspace: Path, session_id: str):
        started_at = time.perf_counter()
        module_name = f"Buffeed_desktop_{session_id.replace('-', '_')}"
        with self._module_load_lock:
            previous_cwd = Path.cwd()
            inserted_path = str(BUFFEED_PATH.parent)
            try:
                if inserted_path not in sys.path:
                    sys.path.insert(0, inserted_path)
                os.chdir(workspace)
                spec = importlib.util.spec_from_file_location(module_name, BUFFEED_PATH)
                if spec is None or spec.loader is None:
                    raise RuntimeError("Unable to load Buffeed runtime")
                module = importlib.util.module_from_spec(spec)
                sys.modules[module_name] = module
                spec.loader.exec_module(module)
                return module
            except Exception:
                sys.modules.pop(module_name, None)
                raise
            finally:
                os.chdir(previous_cwd)
                if inserted_path in sys.path:
                    sys.path.remove(inserted_path)
                _log_timing(
                    "runtime.module_load",
                    started_at,
                    session_id=session_id,
                    project_id=self._project_key(workspace),
                )

    def close(self) -> None:
        with self._lock:
            runtimes = list(self._sessions.values())
        for runtime in runtimes:
            self._shutdown_runtime(runtime)


class CreateSessionRequest(BaseModel):
    workspace: str = Field(min_length=1)


class TurnAttachment(BaseModel):
    path: str | None = Field(default=None, max_length=4_096)
    name: str = Field(default="附件", min_length=1, max_length=256)
    mime_type: str | None = Field(default=None, max_length=128)
    kind: Literal["file", "folder", "image", "video", "audio", "history"] = "file"
    context: str | None = Field(default=None, max_length=30_000)
    preview_url: str | None = Field(default=None, max_length=MAX_ATTACHMENT_PREVIEW_URL_CHARS)


class CreateTurnRequest(BaseModel):
    query: str = Field(min_length=1, max_length=100_000)
    delivery: Literal["queue", "steer"] = "queue"
    request_id: str | None = Field(default=None, min_length=1, max_length=128)
    model: str = Field(default="system", min_length=1, max_length=256)
    attachments: list[TurnAttachment] = Field(default_factory=list, max_length=MAX_TURN_ATTACHMENTS)


class ForkSessionRequest(BaseModel):
    turn_id: str = Field(min_length=1, max_length=128)


class ApprovalDecisionRequest(BaseModel):
    approved: bool


class PluginInstallRequest(BaseModel):
    workspace: str = Field(min_length=1)
    kind: Literal["mcp", "skills"]
    source: str = Field(min_length=1, max_length=500)
    ref: str = Field(default="", max_length=160)
    name: str | None = Field(default=None, max_length=120)
    transport: Literal["stdio", "sse", "streamable-http"] = "stdio"
    command: str | None = Field(default=None, max_length=500)
    args: list[str] = Field(default_factory=list, max_length=32)
    url: str | None = Field(default=None, max_length=2_000)
    headers: dict[str, str] = Field(default_factory=dict, max_length=32)


class PluginUninstallRequest(BaseModel):
    workspace: str = Field(min_length=1)
    kind: Literal["mcp", "skills"]
    name: str = Field(min_length=1, max_length=120)


store = DesktopStore(STATE_DB)
manager = DesktopManager(store)


@asynccontextmanager
async def lifespan(_: FastAPI):
    store.initialize()
    recovered_turns = store.recover_orphaned_turns()
    if recovered_turns:
        LOGGER.warning(
            "recovered orphaned turns after runtime restart",
            extra={"count": recovered_turns},
        )
    manager.prewarm_recent_sessions()
    yield
    manager.close()


app = FastAPI(
    title="Buffeed Agent API",
    version="0.1.0",
    lifespan=lifespan,
)

allowed_origins = [
    origin.strip()
    for origin in os.getenv(
        "DESKTOP_ALLOWED_ORIGINS",
        "http://127.0.0.1:5173,http://localhost:5173,null",
    ).split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "Last-Event-ID"],
)


def _runtime_or_404(session_id: str) -> SessionRuntime:
    try:
        return manager.get_session(session_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Unknown or inactive session") from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Unable to restore Buffeed runtime: {type(exc).__name__}",
        ) from exc


def _plugin_workspace(raw: str) -> Path:
    workspace = Path(raw).expanduser().resolve()
    if not workspace.is_dir():
        raise HTTPException(status_code=400, detail="工作区必须是已存在的目录")
    return workspace


def _github_repo(source: str) -> tuple[str, str]:
    value = source.strip().removesuffix("/")
    parsed = urllib.parse.urlparse(value)
    if parsed.netloc.lower() in {"github.com", "www.github.com"}:
        parts = [part for part in parsed.path.split("/") if part]
    else:
        parts = [part for part in value.split("/") if part]
    if len(parts) != 2 or any(part in {".", ".."} for part in parts):
        raise HTTPException(status_code=400, detail="请输入 owner/repo 或 GitHub 仓库 URL")
    return parts[0], parts[1].removesuffix(".git")


def _github_json(url: str) -> Any:
    request = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "Buffeed"})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"GitHub 请求失败: {exc}") from exc


def _plugin_inventory(workspace: Path) -> dict[str, Any]:
    connected: set[str] = set()
    with manager._lock:
        runtimes = [runtime for runtime in manager._sessions.values() if runtime.workspace == workspace]
    for runtime in runtimes:
        connected.update(getattr(runtime.Buffeed, "mcp_clients", {}).keys())
    skills: list[dict[str, Any]] = []
    for base, origin in ((workspace / "skills", "workspace"), (APP_RUNTIME_DIR / "skills", "bundled")):
        if not base.is_dir():
            continue
        for manifest in sorted(base.glob("*/SKILL.md")):
            try:
                text = manifest.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            name = manifest.parent.name
            description = ""
            if text.startswith("---") and "---" in text[3:]:
                frontmatter = text.split("---", 2)[1]
                for line in frontmatter.splitlines():
                    key, _, value = line.partition(":")
                    if key.strip() == "name": name = value.strip().strip("'\"")
                    if key.strip() == "description": description = value.strip().strip("'\"")
            skills.append({"id": manifest.parent.name, "name": name, "description": description, "origin": origin, "path": str(manifest), "removable": origin == "workspace"})
    mcp_servers: list[dict[str, Any]] = []
    config_paths = [workspace / ".mcp.json", APP_RUNTIME_DIR / ".mcp.json", Path.home() / ".claude" / "mcp.json"]
    seen: set[str] = set()
    for path in config_paths:
        if not path.is_file():
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        for name, config in (payload.get("mcpServers", {}) if isinstance(payload, dict) else {}).items():
            if name in seen or not isinstance(config, dict):
                continue
            seen.add(name)
            mcp_servers.append({"id": name, "name": name, "transport": config.get("transport", "stdio"), "endpoint": config.get("url") or config.get("command", ""), "source": str(path), "status": "connected" if name in connected else "available", "removable": path.resolve() == (workspace / ".mcp.json").resolve()})
    return {"skills": skills, "mcp": mcp_servers}


@app.get("/api/v1/plugins")
async def list_plugins(workspace: str = Query(..., min_length=1)) -> dict[str, Any]:
    return await asyncio.to_thread(_plugin_inventory, _plugin_workspace(workspace))


@app.get("/api/v1/plugins/github/search")
async def search_github_plugins(q: str = Query(..., min_length=2, max_length=120), kind: Literal["mcp", "skills"] = "mcp") -> dict[str, Any]:
    query = f"{q} {'mcp server' if kind == 'mcp' else 'SKILL.md'}"
    data = await asyncio.to_thread(_github_json, "https://api.github.com/search/repositories?per_page=12&q=" + urllib.parse.quote(query))
    return {"items": [{"full_name": item.get("full_name"), "description": item.get("description") or "", "html_url": item.get("html_url"), "default_branch": item.get("default_branch") or "main", "stars": item.get("stargazers_count", 0)} for item in data.get("items", [])]}


def _install_plugin(request: PluginInstallRequest) -> dict[str, Any]:
    workspace = _plugin_workspace(request.workspace)
    owner, repo = _github_repo(request.source)
    ref = request.ref.strip() or "HEAD"
    archive_url = f"https://github.com/{owner}/{repo}/archive/{urllib.parse.quote(ref, safe='')}.zip"
    temp_dir = Path(tempfile.mkdtemp(prefix="buffeed-plugin-"))
    try:
        archive = temp_dir / "repo.zip"
        urllib.request.urlretrieve(archive_url, archive)
        shutil.unpack_archive(str(archive), str(temp_dir / "unpacked"))
        roots = [path for path in (temp_dir / "unpacked").iterdir() if path.is_dir()]
        root = roots[0] if len(roots) == 1 else temp_dir / "unpacked"
        if request.kind == "skills":
            manifests = list(root.rglob("SKILL.md"))
            if not manifests:
                raise ValueError("仓库中未找到 SKILL.md")
            installed: list[str] = []
            destination = workspace / "skills"
            destination.mkdir(parents=True, exist_ok=True)
            for manifest in manifests:
                skill_dir = destination / manifest.parent.name
                if skill_dir.exists():
                    shutil.rmtree(skill_dir)
                shutil.copytree(manifest.parent, skill_dir)
                installed.append(skill_dir.name)
            for runtime in list(manager._sessions.values()):
                if runtime.workspace == workspace:
                    scan = getattr(runtime.Buffeed, "scan_skills", None)
                    if callable(scan):
                        scan()
            return {"kind": "skills", "installed": installed, "source": f"{owner}/{repo}", "message": f"已安装 {len(installed)} 个 Skills"}
        config_path = workspace / ".mcp.json"
        payload: dict[str, Any] = {"mcpServers": {}}
        if config_path.is_file():
            payload = json.loads(config_path.read_text(encoding="utf-8"))
        server_name = request.name or repo
        config: dict[str, Any] | None = None
        for candidate in (root / ".mcp.json", root / "mcp.json"):
            if not candidate.is_file():
                continue
            try:
                discovered = json.loads(candidate.read_text(encoding="utf-8"))
                servers = discovered.get("mcpServers", {}) if isinstance(discovered, dict) else {}
                if isinstance(servers, dict) and servers:
                    selected = request.name if request.name in servers else next(iter(servers))
                    config = dict(servers[selected]) if isinstance(servers[selected], dict) else None
                    server_name = request.name or selected
                    break
            except (OSError, json.JSONDecodeError):
                continue
        if config is None:
            config = {"transport": request.transport}
            if request.transport == "stdio":
                if not request.command:
                    raise ValueError("MCP stdio 需要填写启动命令（仓库未提供 mcp.json）")
                config.update({"command": request.command, "args": request.args})
            else:
                if not request.url:
                    raise ValueError("远程 MCP 需要填写 URL（仓库未提供 mcp.json）")
                config.update({"url": request.url, "headers": request.headers})
        payload.setdefault("mcpServers", {})[server_name] = config
        config_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return {"kind": "mcp", "installed": [server_name], "source": f"{owner}/{repo}", "message": f"已写入 MCP 配置: {server_name}"}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"插件安装失败: {exc}") from exc
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


@app.post("/api/v1/plugins/install")
async def install_plugin(request: PluginInstallRequest) -> dict[str, Any]:
    result = await asyncio.to_thread(_install_plugin, request)
    return result


def _uninstall_plugin(request: PluginUninstallRequest) -> dict[str, Any]:
    workspace = _plugin_workspace(request.workspace)
    name = request.name.strip()
    if request.kind == "skills":
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,120}", name):
            raise HTTPException(status_code=400, detail="无效的 Skill 名称")
        skills_root = (workspace / "skills").resolve()
        skill_dir = (skills_root / name).resolve()
        try:
            skill_dir.relative_to(skills_root)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Skill 路径无效") from exc
        if not (skill_dir / "SKILL.md").is_file():
            raise HTTPException(status_code=404, detail="工作区中未找到该 Skill")
        shutil.rmtree(skill_dir)
        for runtime in list(manager._sessions.values()):
            if runtime.workspace == workspace:
                scan = getattr(runtime.Buffeed, "scan_skills", None)
                if callable(scan):
                    scan()
        return {"kind": "skills", "removed": [name], "message": f"已卸载 Skill: {name}"}

    config_path = workspace / ".mcp.json"
    if not config_path.is_file():
        raise HTTPException(status_code=404, detail="工作区中未找到 MCP 配置")
    try:
        payload = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail="MCP 配置文件无效") from exc
    servers = payload.get("mcpServers") if isinstance(payload, dict) else None
    if not isinstance(servers, dict) or name not in servers:
        raise HTTPException(status_code=404, detail="工作区中未找到该 MCP")
    del servers[name]
    config_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for runtime in list(manager._sessions.values()):
        if runtime.workspace == workspace:
            disconnect = getattr(runtime.Buffeed, "disconnect_mcp", None)
            if callable(disconnect):
                disconnect(name)
    return {"kind": "mcp", "removed": [name], "message": f"已卸载 MCP: {name}"}


@app.post("/api/v1/plugins/uninstall")
async def uninstall_plugin(request: PluginUninstallRequest) -> dict[str, Any]:
    return await asyncio.to_thread(_uninstall_plugin, request)


def _effective_event_cursor(after: int, last_event_id: str | None) -> int:
    """Prefer the standard SSE cursor while tolerating malformed clients."""
    if last_event_id is None:
        return after
    try:
        parsed = int(last_event_id.strip())
    except (TypeError, ValueError):
        return after
    return max(after, parsed) if parsed >= 0 else after


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "host": API_HOST,
        "active_sessions": len(manager._sessions),
        "team_tools_enabled": TEAM_TOOLS_ENABLED,
        "team_tools": sorted(TEAM_MUTATION_TOOLS) if TEAM_TOOLS_ENABLED else [],
    }


@app.get("/api/v1/models")
async def list_models() -> dict[str, Any]:
    return {"models": configured_turn_models()}


@app.get("/api/v1/sessions")
async def list_sessions() -> dict[str, Any]:
    sessions = [
        {
            **session,
            "history_mode": manager.history_mode(str(session["session_id"])),
        }
        for session in store.list_sessions()
    ]
    return {"sessions": sessions}


@app.post("/api/v1/sessions", status_code=201)
async def create_session(request: CreateSessionRequest) -> dict[str, Any]:
    try:
        runtime = manager.create_session(request.workspace)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Unable to initialize Buffeed runtime: {type(exc).__name__}",
        ) from exc
    return {
        "session_id": runtime.session_id,
        "workspace": str(runtime.workspace),
        "disabled_tools": sorted(DESKTOP_DISABLED_TOOLS),
    }


@app.post("/api/v1/sessions/{session_id}/fork", status_code=201)
async def fork_session(session_id: str, request: ForkSessionRequest) -> dict[str, Any]:
    source = store.get_session(session_id)
    if source is None:
        raise HTTPException(status_code=404, detail="Unknown session")
    turn = await asyncio.to_thread(store.get_turn, request.turn_id)
    if turn is None or str(turn["session_id"]) != session_id:
        raise HTTPException(status_code=404, detail="Unknown turn")
    new_session_id = str(uuid.uuid4())
    try:
        forked = await asyncio.to_thread(
            store.fork_session,
            session_id,
            request.turn_id,
            new_session_id,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Unknown session or turn") from exc
    return {
        **forked,
        "session_id": new_session_id,
        "workspace": str(forked["workspace"]),
        "disabled_tools": sorted(DESKTOP_DISABLED_TOOLS),
        "forked_from": session_id,
        "forked_turn_id": request.turn_id,
    }


@app.get("/api/v1/sessions/{session_id}")
async def get_session(session_id: str) -> dict[str, Any]:
    started_at = time.perf_counter()
    session = store.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Unknown session")
    runtime = manager.get_cached_runtime(session_id)
    runtime_status = manager.runtime_status(session_id)
    if runtime is None:
        runtime_status = manager.warm_session(session_id)
    _log_timing(
        "session.select",
        started_at,
        session_id=session_id,
        runtime_status=runtime_status,
    )
    return {
        **session,
        "active_turn_id": runtime.active_turn_id if runtime else None,
        "runtime_status": runtime_status,
        "history_mode": manager.history_mode(session_id),
        "disabled_tools": sorted(DESKTOP_DISABLED_TOOLS),
    }


@app.get("/api/v1/sessions/{session_id}/team")
async def get_team_observation(session_id: str) -> dict[str, Any]:
    session = store.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Unknown session")
    runtime = manager.get_cached_runtime(session_id)
    if runtime is None:
        manager.warm_session(session_id)
        # Restoration is asynchronous, but a fast restore can complete before
        # the journal query below. Re-read the cache so execution selection and
        # the active turn are based on the restored runtime rather than the
        # historical-event fallback.
        runtime = manager.get_cached_runtime(session_id)
    all_events = await asyncio.to_thread(store.events_after, session_id, 0)
    all_team_events = [
        event for event in all_events if event.get("event_type", "").startswith("run.")
    ]
    execution_id = runtime.team_execution_id(all_team_events) if runtime else next(
        (
            str(event["payload"].get("execution_id"))
            for event in reversed(all_team_events)
            if isinstance(event.get("payload"), dict)
            and event["payload"].get("execution_id")
        ),
        session_id,
    )
    team_events = (
        runtime.events_for_execution(all_team_events, execution_id)
        if runtime
        else [
            event
            for event in all_team_events
            if isinstance(event.get("payload"), dict)
            and event["payload"].get("execution_id") == execution_id
        ]
    )
    snapshot = await asyncio.to_thread(
        build_team_snapshot,
        runtime.Buffeed if runtime else None,
        execution_id=execution_id,
        active_turn_id=runtime.active_turn_id if runtime else None,
        team_events=team_events,
    )
    snapshot["events"] = team_events[-100:]
    return snapshot


@app.get("/api/v1/sessions/{session_id}/team/events")
async def replay_team_events(
    session_id: str,
    after: int = Query(default=0, ge=0),
    execution_id: str | None = Query(default=None, min_length=1),
    last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
) -> dict[str, Any]:
    session = store.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Unknown session")
    runtime = manager.get_cached_runtime(session_id)
    if runtime is None:
        manager.warm_session(session_id)
        runtime = manager.get_cached_runtime(session_id)
    cursor_after = _effective_event_cursor(after, last_event_id)
    all_events = await asyncio.to_thread(store.events_after, session_id, 0)
    all_team_events = [
        event for event in all_events if event.get("event_type", "").startswith("run.")
    ]
    selected_execution_id = execution_id or (
        runtime.team_execution_id(all_team_events)
        if runtime
        else next(
            (
                str(event["payload"].get("execution_id"))
                for event in reversed(all_team_events)
                if isinstance(event.get("payload"), dict)
                and event["payload"].get("execution_id")
            ),
            session_id,
        )
    )
    events = [
        event
        for event in all_team_events
        if event["event_id"] > cursor_after
        and isinstance(event.get("payload"), dict)
        and event["payload"].get("execution_id") == selected_execution_id
    ]
    selected_events = (
        runtime.events_for_execution(all_team_events, selected_execution_id)
        if runtime
        else [
            event
            for event in all_team_events
            if isinstance(event.get("payload"), dict)
            and event["payload"].get("execution_id") == selected_execution_id
        ]
    )
    snapshot = await asyncio.to_thread(
        build_team_snapshot,
        runtime.Buffeed if runtime else None,
        execution_id=selected_execution_id,
        active_turn_id=runtime.active_turn_id if runtime else None,
        team_events=selected_events,
    )
    snapshot["events"] = selected_events[-100:]
    return {
        "execution_id": selected_execution_id,
        "events": events,
        "snapshot": snapshot,
    }


@app.post("/api/v1/sessions/{session_id}/turns", status_code=202)
async def create_turn(session_id: str, request: CreateTurnRequest) -> dict[str, Any]:
    query = request.query.strip()
    if not query:
        raise HTTPException(status_code=422, detail="query cannot be empty")
    try:
        # Persist first and let a ready runtime run it, or queue it while the
        # runtime is cold/restoring. The HTTP response never waits for model setup.
        delivery = request.delivery
        result = await asyncio.to_thread(
            manager.deliver_turn,
            session_id,
            query,
            delivery,
            [item.model_dump() for item in request.attachments],
            request.request_id,
            request.model,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Unknown session") from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return result


@app.get("/api/v1/sessions/{session_id}/turns/{turn_id}")
async def get_turn(session_id: str, turn_id: str) -> dict[str, Any]:
    turn = await asyncio.to_thread(store.get_turn, turn_id)
    if turn is None or str(turn["session_id"]) != session_id:
        raise HTTPException(status_code=404, detail="Unknown turn")
    return turn


@app.post("/api/v1/sessions/{session_id}/turns/{turn_id}:cancel", status_code=202)
async def cancel_turn(session_id: str, turn_id: str) -> dict[str, Any]:
    if not await asyncio.to_thread(manager.cancel_turn, session_id, turn_id):
        raise HTTPException(status_code=409, detail="Turn is not active")
    return {"turn_id": turn_id, "status": "cancellation_requested"}


@app.get("/api/v1/sessions/{session_id}/changes")
async def get_session_changes(session_id: str) -> dict[str, Any]:
    runtime = manager.get_cached_runtime(session_id)
    if runtime is not None:
        snapshot = await asyncio.to_thread(runtime.changes_snapshot)
        baseline_paths = runtime._baseline_for_snapshot()
    else:
        session = store.get_session(session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Unknown session")
        workspace = Path(str(session["workspace"])).expanduser().resolve()
        manager.warm_session(session_id)
        baseline_paths = manager.project_baseline_paths(workspace)
        snapshot = await asyncio.to_thread(_git_change_snapshot, workspace)
        snapshot["files"] = [
            item for item in snapshot["files"] if item["path"] not in baseline_paths
        ]
        snapshot["total_files"] = len(snapshot["files"])
        snapshot["total_additions"] = sum(item["additions"] for item in snapshot["files"])
        snapshot["total_deletions"] = sum(item["deletions"] for item in snapshot["files"])
    snapshot["protected_paths"] = sorted(
        item["path"] for item in snapshot["files"]
        if item["path"] in baseline_paths
    )
    snapshot["revertible_files"] = sum(
        1 for item in snapshot["files"] if item["path"] not in baseline_paths
    )
    return snapshot


@app.post("/api/v1/sessions/{session_id}/changes:revert")
async def revert_session_changes(session_id: str) -> dict[str, Any]:
    runtime = _runtime_or_404(session_id)
    try:
        return await asyncio.to_thread(runtime.revert_changes)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/api/v1/sessions/{session_id}/changes:review")
async def review_session_changes(session_id: str) -> dict[str, Any]:
    runtime = _runtime_or_404(session_id)
    return await asyncio.to_thread(runtime.review_changes)


@app.post("/api/v1/approvals/{approval_id}")
async def resolve_approval(
    approval_id: str,
    request: ApprovalDecisionRequest,
) -> dict[str, Any]:
    with manager._lock:
        runtimes = list(manager._sessions.values())
    for runtime in runtimes:
        if runtime.approvals.resolve(approval_id, request.approved):
            return {"approval_id": approval_id, "approved": request.approved}
    raise HTTPException(status_code=404, detail="Approval is no longer pending")


@app.get("/api/v1/sessions/{session_id}/events")
async def stream_events(
    session_id: str,
    after: int = Query(default=0, ge=0),
    stream: bool = Query(default=True),
    summary: bool = Query(default=False),
    full_history: bool = Query(default=False),
    before: int | None = Query(default=None, ge=1),
    limit: int = Query(default=HISTORY_WINDOW_EVENTS, ge=25, le=500),
    last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
) -> Response:
    session = store.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Unknown session")
    manager.warm_session(session_id)
    cursor_after = _effective_event_cursor(after, last_event_id)
    if not stream:
        started_at = time.perf_counter()
        has_more = False
        if full_history and before is not None:
            raise HTTPException(status_code=422, detail="full_history cannot be combined with before")
        if full_history and cursor_after == 0:
            events = await asyncio.to_thread(
                store.history_events_after,
                session_id,
                0,
                summary=summary,
            )
            oldest_event_id = events[0]["event_id"] if events else None
            latest_event_id = events[-1]["event_id"] if events else 0
        elif before is not None:
            events, has_more, oldest_event_id, latest_event_id = await asyncio.to_thread(
                store.history_events_before,
                session_id,
                before,
                limit,
                summary=summary,
            )
        elif cursor_after == 0:
            events, has_more, oldest_event_id, latest_event_id = await asyncio.to_thread(
                store.history_events_tail,
                session_id,
                limit,
                summary=summary,
            )
        else:
            events = await asyncio.to_thread(
                store.events_after,
                session_id,
                cursor_after,
                summary=summary,
            )
            oldest_event_id = events[0]["event_id"] if events else None
            latest_event_id = events[-1]["event_id"] if events else cursor_after
        _log_timing(
            "history.poll",
            started_at,
            session_id=session_id,
            event_count=len(events),
            compacted=before is not None or cursor_after == 0,
        )
        return JSONResponse({
            "events": events,
            "has_more_history": has_more,
            "oldest_event_id": oldest_event_id,
            "latest_event_id": latest_event_id,
        })

    if before is not None:
        raise HTTPException(status_code=422, detail="before is only valid when stream=false")

    async def event_stream():
        started_at = time.perf_counter()
        cursor = cursor_after
        persisted = await asyncio.to_thread(
            store.history_events_after if (cursor == 0 and full_history) else store.events_after,
            session_id,
            cursor,
        )
        for event in persisted:
            cursor = event["event_id"]
            yield _format_sse(event)
        _log_timing(
            "history.replay",
            started_at,
            session_id=session_id,
            event_count=len(persisted),
            compacted=cursor_after == 0,
        )
        while True:
            runtime = manager.get_cached_runtime(session_id)
            if runtime is None:
                await asyncio.sleep(0.5)
                events = await asyncio.to_thread(store.events_after, session_id, cursor)
            else:
                events = await asyncio.to_thread(runtime.broker.wait_after, cursor, 15.0)
            if not events:
                yield ": keepalive\n\n"
                continue
            for event in events:
                cursor = event["event_id"]
                yield _format_sse(event)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/v1/sessions/{session_id}/events/{event_id}")
async def get_event_detail(session_id: str, event_id: int) -> dict[str, Any]:
    session = await asyncio.to_thread(store.get_session, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Unknown session")
    event = await asyncio.to_thread(store.get_event, session_id, event_id)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not found")
    return event


@app.get("/api/v1/sessions/{session_id}/mcp")
async def list_mcp_servers(session_id: str) -> dict[str, Any]:
    runtime = _runtime_or_404(session_id)
    try:
        return json.loads(runtime.Buffeed.list_mcp_servers())
    except ValueError as exc:
        raise HTTPException(status_code=500, detail="MCP server list is invalid") from exc


@app.post("/api/v1/sessions/{session_id}/mcp/{server_name}:connect")
async def connect_mcp_server(session_id: str, server_name: str) -> dict[str, Any]:
    runtime = _runtime_or_404(session_id)
    output = await asyncio.to_thread(runtime.Buffeed.connect_mcp, server_name)
    return {"server": server_name, "result": output}


def _format_sse(event: dict[str, Any]) -> str:
    payload = {
        "turn_id": event["turn_id"],
        "payload": event["payload"],
        "created_at": event["created_at"],
    }
    return (
        f"id: {event['event_id']}\n"
        f"event: {event['event_type']}\n"
        f"data: {_json(payload)}\n\n"
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=API_HOST, port=API_PORT, log_level="info")
