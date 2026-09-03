from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal
from uuid import UUID, uuid4

import asyncpg

from rag_observability import get_request_id


TaskStatus = Literal[
    "queued",
    "vector_ready",
    "kg_pending",
    "kg_running",
    "graph_ready",
    "failed",
    "cancelled",
]
TaskType = Literal["ingest", "rebuild", "graph", "delete"]
_TERMINAL_STATUSES = {"vector_ready", "graph_ready", "failed", "cancelled"}
_JOB_COLUMNS = """
    task_id, document_id, revision, task_type, status, attempt,
    lightrag_track_id, payload, error_detail, parent_task_id, cancel_requested_at,
    request_id
"""


class TaskClaimLost(RuntimeError):
    """Raised when a worker attempts to update a task after its lease changed."""


@dataclass(frozen=True)
class RagJob:
    task_id: UUID
    document_id: UUID
    revision: int
    task_type: TaskType
    status: TaskStatus
    attempt: int
    lightrag_track_id: str | None
    payload: dict[str, Any]
    error_detail: str | None
    parent_task_id: UUID | None
    cancel_requested_at: datetime | None
    request_id: str | None


class RagJobStore:
    """PostgreSQL-backed claims and transitions for the external RAG worker."""

    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def get(self, task_id: UUID) -> RagJob:
        async with self._pool.acquire() as connection:
            row = await connection.fetchrow(
                f"""
                SELECT {_JOB_COLUMNS}
                FROM rag.ingest_tasks
                WHERE task_id = $1
                """,
                task_id,
            )
        if row is None:
            raise ValueError("Unknown RAG task")
        return _row_to_job(row)

    async def events(self, task_id: UUID) -> list[dict[str, Any]]:
        async with self._pool.acquire() as connection:
            rows = await connection.fetch(
                """
                SELECT
                    event_id, from_status, to_status, detail, worker_id, request_id,
                    occurred_at
                FROM rag.ingest_task_events
                WHERE task_id = $1
                ORDER BY occurred_at, event_id
                """,
                task_id,
            )
        return [
            {
                "event_id": row["event_id"],
                "from_status": row["from_status"],
                "to_status": row["to_status"],
                "detail": row["detail"],
                "worker_id": row["worker_id"],
                "request_id": row["request_id"],
                "occurred_at": row["occurred_at"].isoformat(),
            }
            for row in rows
        ]

    async def children(self, parent_task_id: UUID) -> list[RagJob]:
        async with self._pool.acquire() as connection:
            rows = await connection.fetch(
                f"""
                SELECT {_JOB_COLUMNS}
                FROM rag.ingest_tasks
                WHERE parent_task_id = $1
                ORDER BY requested_at, task_id
                """,
                parent_task_id,
            )
        return [_row_to_job(row) for row in rows]

    async def submit_delete(
        self,
        document_id: UUID,
        *,
        delete_files: bool,
        delete_llm_cache: bool,
    ) -> RagJob:
        task_id = uuid4()
        request_id = get_request_id()
        async with self._pool.acquire() as connection:
            async with connection.transaction():
                document = await connection.fetchrow(
                    """
                    SELECT current_revision
                    FROM rag.documents
                    WHERE document_id = $1 AND deleted_at IS NULL
                    FOR UPDATE
                    """,
                    document_id,
                )
                if document is None:
                    raise ValueError("Unknown or deleted document")

                existing = await connection.fetchrow(
                    f"""
                    SELECT {_JOB_COLUMNS}
                    FROM rag.ingest_tasks
                    WHERE document_id = $1
                      AND task_type = 'delete'
                      AND status NOT IN ('graph_ready', 'failed', 'cancelled')
                    ORDER BY requested_at DESC
                    LIMIT 1
                    FOR UPDATE
                    """,
                    document_id,
                )
                if existing is not None:
                    return _row_to_job(existing)

                revision = document["current_revision"]
                await connection.execute(
                    """
                    UPDATE rag.documents
                    SET delete_requested_at = now(), updated_at = now()
                    WHERE document_id = $1
                    """,
                    document_id,
                )
                row = await connection.fetchrow(
                    f"""
                    INSERT INTO rag.ingest_tasks (
                        task_id, document_id, revision, task_type, status, payload,
                        next_attempt_at, request_id
                    )
                    VALUES ($1, $2, $3, 'delete', 'queued', $4::jsonb, now(), $5)
                    RETURNING {_JOB_COLUMNS}
                    """,
                    task_id,
                    document_id,
                    revision,
                    json.dumps(
                        {
                            "delete_files": delete_files,
                            "delete_llm_cache": delete_llm_cache,
                        }
                    ),
                    request_id,
                )
                await self._record_event(
                    connection, task_id, None, "queued", "delete requested"
                )
        return _row_to_job(row)

    async def claim_next(self, worker_id: str, lease_seconds: int) -> RagJob | None:
        if lease_seconds < 1:
            raise ValueError("lease_seconds must be positive")
        async with self._pool.acquire() as connection:
            async with connection.transaction():
                row = await connection.fetchrow(
                    f"""
                    SELECT {_JOB_COLUMNS}
                    FROM rag.ingest_tasks
                    WHERE (
                        status IN ('queued', 'kg_pending')
                        OR (status = 'kg_running' AND lease_expires_at <= now())
                    )
                      AND (cancel_requested_at IS NOT NULL OR next_attempt_at <= now())
                      AND (lease_expires_at IS NULL OR lease_expires_at <= now())
                    ORDER BY (cancel_requested_at IS NULL), requested_at, task_id
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1
                    """
                )
                if row is None:
                    return None

                next_status = "kg_running" if row["status"] == "kg_pending" else row["status"]
                if next_status != row["status"]:
                    await connection.execute(
                        """
                        UPDATE rag.ingest_tasks
                        SET status = $2, updated_at = now()
                        WHERE task_id = $1
                        """,
                        row["task_id"],
                        next_status,
                    )
                    await self._record_event(
                        connection,
                        row["task_id"],
                        row["status"],
                        next_status,
                        "graph worker claimed task",
                        worker_id,
                        request_id=row["request_id"],
                    )
                elif row["status"] == "kg_running":
                    await self._record_event(
                        connection,
                        row["task_id"],
                        "kg_running",
                        "kg_running",
                        "expired worker lease recovered",
                        worker_id,
                        request_id=row["request_id"],
                    )

                claimed = await connection.fetchrow(
                    f"""
                    UPDATE rag.ingest_tasks
                    SET lease_owner = $2,
                        lease_expires_at = now() + ($3::integer * interval '1 second'),
                        started_at = COALESCE(started_at, now()),
                        updated_at = now()
                    WHERE task_id = $1
                    RETURNING {_JOB_COLUMNS}
                    """,
                    row["task_id"],
                    worker_id,
                    lease_seconds,
                )
        return _row_to_job(claimed)

    async def record_track_id(
        self, task_id: UUID, track_id: str, *, worker_id: str | None = None
    ) -> None:
        normalized_track_id = track_id.strip()
        if not normalized_track_id:
            raise ValueError("track_id cannot be empty")
        async with self._pool.acquire() as connection:
            result = await connection.execute(
                """
                UPDATE rag.ingest_tasks
                SET lightrag_track_id = $2, error_detail = NULL, updated_at = now()
                WHERE task_id = $1
                  AND cancel_requested_at IS NULL
                  AND ($3::text IS NULL OR lease_owner = $3)
                """,
                task_id,
                normalized_track_id,
                worker_id,
            )
        if result != "UPDATE 1":
            raise TaskClaimLost("RAG task lease was lost before its track ID was saved")

    async def mark_vector_ready(
        self,
        task_id: UUID,
        detail: str,
        *,
        worker_id: str,
        graph_payload: dict[str, Any] | None = None,
    ) -> None:
        async with self._pool.acquire() as connection:
            async with connection.transaction():
                row = await connection.fetchrow(
                    """
                    SELECT
                        task_id, document_id, revision, task_type, status,
                        lightrag_track_id, lease_owner, cancel_requested_at, request_id
                    FROM rag.ingest_tasks
                    WHERE task_id = $1
                    FOR UPDATE
                    """,
                    task_id,
                )
                if row is None:
                    raise ValueError("Unknown RAG task")
                if row["status"] == "vector_ready":
                    return
                if row["task_type"] not in {"ingest", "rebuild"}:
                    raise ValueError("Only ingest tasks can become vector_ready")
                self._require_claim(row, worker_id)
                if row["cancel_requested_at"] is not None:
                    raise TaskClaimLost("RAG task was cancelled before vector readiness")
                if not row["lightrag_track_id"]:
                    raise ValueError("A LightRAG track ID is required before vector readiness")

                result = await connection.execute(
                    """
                    UPDATE rag.ingest_tasks
                    SET status = 'vector_ready', vector_ready_at = now(),
                        lease_owner = NULL, lease_expires_at = NULL,
                        finished_at = now(), error_detail = NULL, updated_at = now()
                    WHERE task_id = $1
                    """,
                    task_id,
                )
                if result != "UPDATE 1":
                    raise TaskClaimLost("RAG task could not be marked vector_ready")
                await self._record_event(
                    connection, task_id, row["status"], "vector_ready", detail, worker_id
                )

                graph_task_id = uuid4()
                inserted = await connection.fetchrow(
                    """
                    INSERT INTO rag.ingest_tasks (
                        task_id, document_id, revision, task_type, status,
                        parent_task_id, lightrag_track_id, payload, next_attempt_at,
                        request_id
                    )
                    VALUES (
                        $1, $2, $3, 'graph', 'kg_pending', $4, $5, $6::jsonb, now(), $7
                    )
                    ON CONFLICT (parent_task_id, task_type)
                    WHERE parent_task_id IS NOT NULL
                    DO NOTHING
                    RETURNING task_id
                    """,
                    graph_task_id,
                    row["document_id"],
                    row["revision"],
                    task_id,
                    row["lightrag_track_id"],
                    json.dumps(graph_payload or {}),
                    row["request_id"],
                )
                if inserted is not None:
                    await self._record_event(
                        connection,
                        graph_task_id,
                        None,
                        "kg_pending",
                        "graph stage queued after vector readiness",
                        worker_id,
                    )

    async def mark_graph_ready(
        self, task_id: UUID, detail: str, *, worker_id: str
    ) -> None:
        await self._finish(task_id, "graph_ready", detail, worker_id=worker_id)

    async def mark_failed(
        self, task_id: UUID, detail: str, *, worker_id: str | None = None
    ) -> None:
        await self._finish(task_id, "failed", detail[:4000], worker_id=worker_id)

    async def mark_cancelled(self, task_id: UUID, detail: str, *, worker_id: str) -> None:
        await self._finish(task_id, "cancelled", detail[:4000], worker_id=worker_id)

    async def reschedule(
        self,
        task_id: UUID,
        status: Literal["queued", "kg_pending"],
        delay_seconds: int,
        detail: str,
        *,
        worker_id: str,
        increment_attempt: bool = False,
    ) -> None:
        if delay_seconds < 0:
            raise ValueError("delay_seconds cannot be negative")
        async with self._pool.acquire() as connection:
            async with connection.transaction():
                row = await connection.fetchrow(
                    """
                    SELECT status, lease_owner, cancel_requested_at
                    FROM rag.ingest_tasks
                    WHERE task_id = $1
                    FOR UPDATE
                    """,
                    task_id,
                )
                if row is None:
                    raise ValueError("Unknown RAG task")
                self._require_claim(row, worker_id)
                if row["cancel_requested_at"] is not None:
                    raise TaskClaimLost("RAG task was cancelled before rescheduling")
                result = await connection.execute(
                    """
                    UPDATE rag.ingest_tasks
                    SET status = $2, lease_owner = NULL, lease_expires_at = NULL,
                        next_attempt_at = now() + ($3::integer * interval '1 second'),
                        error_detail = $4, attempt = attempt + $5, updated_at = now()
                    WHERE task_id = $1
                    """,
                    task_id,
                    status,
                    delay_seconds,
                    detail[:4000],
                    1 if increment_attempt else 0,
                )
                if result != "UPDATE 1":
                    raise TaskClaimLost("RAG task could not be rescheduled")
                await self._record_event(
                    connection, task_id, row["status"], status, detail, worker_id
                )

    async def cancel(self, task_id: UUID, detail: str = "cancel requested") -> RagJob:
        async with self._pool.acquire() as connection:
            async with connection.transaction():
                row = await connection.fetchrow(
                    f"""
                    SELECT {_JOB_COLUMNS}
                    FROM rag.ingest_tasks
                    WHERE task_id = $1
                    FOR UPDATE
                    """,
                    task_id,
                )
                if row is None:
                    raise ValueError("Unknown RAG task")
                if row["status"] in _TERMINAL_STATUSES:
                    return _row_to_job(row)

                updated = await connection.fetchrow(
                    f"""
                    UPDATE rag.ingest_tasks
                    SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
                        lease_expires_at = now(), next_attempt_at = now(),
                        error_detail = $2, updated_at = now()
                    WHERE task_id = $1
                    RETURNING {_JOB_COLUMNS}
                    """,
                    task_id,
                    detail[:4000],
                )
                await self._record_event(
                    connection, task_id, row["status"], row["status"], detail
                )
        return _row_to_job(updated)

    async def retry(self, task_id: UUID, detail: str = "retry requested") -> RagJob:
        async with self._pool.acquire() as connection:
            async with connection.transaction():
                row = await connection.fetchrow(
                    f"""
                    SELECT {_JOB_COLUMNS}
                    FROM rag.ingest_tasks
                    WHERE task_id = $1
                    FOR UPDATE
                    """,
                    task_id,
                )
                if row is None:
                    raise ValueError("Unknown RAG task")
                if row["status"] not in {"failed", "cancelled"}:
                    raise ValueError("Only failed or cancelled RAG tasks can be retried")

                next_status = "kg_pending" if row["task_type"] == "graph" else "queued"
                updated = await connection.fetchrow(
                    f"""
                    UPDATE rag.ingest_tasks
                    SET status = $2, lease_owner = NULL, lease_expires_at = NULL,
                        next_attempt_at = now(), cancel_requested_at = NULL,
                        finished_at = NULL, error_detail = NULL, updated_at = now()
                    WHERE task_id = $1
                    RETURNING {_JOB_COLUMNS}
                    """,
                    task_id,
                    next_status,
                )
                if row["task_type"] == "delete":
                    await connection.execute(
                        """
                        UPDATE rag.documents
                        SET delete_requested_at = now(), updated_at = now()
                        WHERE document_id = $1 AND deleted_at IS NULL
                        """,
                        row["document_id"],
                    )
                await self._record_event(
                    connection, task_id, row["status"], next_status, detail
                )
        return _row_to_job(updated)

    async def _finish(
        self,
        task_id: UUID,
        status: TaskStatus,
        detail: str,
        *,
        worker_id: str | None,
    ) -> None:
        if status not in _TERMINAL_STATUSES:
            raise ValueError("_finish accepts only terminal statuses")
        async with self._pool.acquire() as connection:
            async with connection.transaction():
                row = await connection.fetchrow(
                    """
                    SELECT status, task_type, lease_owner
                    FROM rag.ingest_tasks
                    WHERE task_id = $1
                    FOR UPDATE
                    """,
                    task_id,
                )
                if row is None:
                    raise ValueError("Unknown RAG task")
                if row["status"] in _TERMINAL_STATUSES:
                    if row["status"] == status:
                        return
                    raise TaskClaimLost("RAG task already reached a terminal state")
                if status == "graph_ready" and row["task_type"] in {"ingest", "rebuild"}:
                    raise ValueError("Ingest tasks must finish at vector_ready")
                if worker_id is not None:
                    self._require_claim(row, worker_id)
                result = await connection.execute(
                    """
                    UPDATE rag.ingest_tasks
                    SET status = $2, lease_owner = NULL, lease_expires_at = NULL,
                        finished_at = now(), error_detail = $3,
                        graph_ready_at = CASE WHEN $2 = 'graph_ready' THEN now() ELSE graph_ready_at END,
                        updated_at = now()
                    WHERE task_id = $1
                    """,
                    task_id,
                    status,
                    detail[:4000] if detail else None,
                )
                if result != "UPDATE 1":
                    raise TaskClaimLost("RAG task could not be finalized")
                await self._record_event(
                    connection, task_id, row["status"], status, detail, worker_id
                )

    @staticmethod
    def _require_claim(row: asyncpg.Record, worker_id: str) -> None:
        if row["lease_owner"] != worker_id:
            raise TaskClaimLost("RAG task is no longer owned by this worker")

    @staticmethod
    async def _record_event(
        connection: asyncpg.Connection,
        task_id: UUID,
        from_status: str | None,
        to_status: str,
        detail: str,
        worker_id: str | None = None,
        request_id: str | None = None,
    ) -> None:
        if request_id is None:
            request_id = get_request_id()
        await connection.execute(
            """
            INSERT INTO rag.ingest_task_events (
                task_id, from_status, to_status, detail, worker_id, request_id
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            """,
            task_id,
            from_status,
            to_status,
            detail[:4000] if detail else None,
            worker_id,
            request_id,
        )


def _row_to_job(row: asyncpg.Record) -> RagJob:
    payload = row["payload"]
    if isinstance(payload, str):
        payload = json.loads(payload)
    if not isinstance(payload, dict):
        payload = {}
    return RagJob(
        task_id=row["task_id"],
        document_id=row["document_id"],
        revision=row["revision"],
        task_type=row["task_type"],
        status=row["status"],
        attempt=row["attempt"],
        lightrag_track_id=row["lightrag_track_id"],
        payload=payload,
        error_detail=row["error_detail"],
        parent_task_id=row["parent_task_id"],
        cancel_requested_at=row["cancel_requested_at"],
        request_id=row["request_id"],
    )
