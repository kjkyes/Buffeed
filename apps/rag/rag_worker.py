from __future__ import annotations

import argparse
import asyncio
import os
import socket
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse
from urllib.request import url2pathname

import rag_config  # noqa: F401 - load the active profile before settings imports
from lightrag_client import GatewaySettings, LightRAGClient, LightRAGError, ProcessingProfile
from rag_database import PostgresSettings, create_postgres_pool
from rag_jobs import RagJob, RagJobStore, TaskClaimLost
from rag_observability import configure_logging, elapsed_ms, log_event, metrics, request_context
from rag_registry import (
    ArtifactStore,
    ParserIsolation,
    RagRegistry,
    RagRegistryRetryableError,
)
from rag_visual_fallback import (
    VisualFallbackError,
    VisualFallbackSettings,
    VisualTextFallback,
)


logger = configure_logging("rag_worker", os.getenv("RAG_WORKER_LOG_LEVEL"))


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw_value = os.getenv(name, str(default))
    try:
        value = int(raw_value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


def _env_bool(name: str, default: bool) -> bool:
    raw_value = os.getenv(name)
    if raw_value is None:
        return default
    normalized = raw_value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be a boolean")


def _env_path(name: str, default: str) -> Path:
    raw_value = os.getenv(name, default).strip()
    if not raw_value:
        raise ValueError(f"{name} cannot be empty")
    return Path(raw_value).expanduser().resolve()


def _default_workspace() -> str:
    workspace = os.getenv("LIGHTRAG_WORKSPACE", "").strip()
    if not workspace:
        workspace = os.getenv("RAG_PRODUCTION_WORKSPACE", "default").strip()
    if not workspace:
        raise ValueError("LIGHTRAG_WORKSPACE cannot be empty")
    return workspace


@dataclass(frozen=True)
class WorkerSettings:
    worker_id: str
    poll_seconds: int
    lease_seconds: int
    retry_base_seconds: int
    retry_max_seconds: int
    max_attempts: int
    allow_pipeline_cancel: bool
    workspace: str
    lightrag_sidecar_root: Path
    graph_working_dir: Path
    visual_fallback: VisualFallbackSettings

    @classmethod
    def from_env(cls) -> "WorkerSettings":
        default_worker_id = f"{socket.gethostname()}-{os.getpid()}"
        worker_id = os.getenv("RAG_WORKER_ID", default_worker_id).strip()
        if not worker_id:
            raise ValueError("RAG_WORKER_ID cannot be empty")
        artifact_root = _env_path("RAG_ARTIFACT_ROOT", "./rag_artifacts")
        return cls(
            worker_id=worker_id,
            poll_seconds=_env_int("RAG_WORKER_POLL_SECONDS", 5, 1, 60),
            lease_seconds=_env_int("RAG_WORKER_LEASE_SECONDS", 300, 30, 3600),
            retry_base_seconds=_env_int("RAG_WORKER_RETRY_BASE_SECONDS", 10, 1, 3600),
            retry_max_seconds=_env_int("RAG_WORKER_RETRY_MAX_SECONDS", 300, 1, 3600),
            max_attempts=_env_int("RAG_WORKER_MAX_ATTEMPTS", 5, 1, 100),
            allow_pipeline_cancel=_env_bool("RAG_WORKER_ALLOW_PIPELINE_CANCEL", True),
            workspace=_default_workspace(),
            lightrag_sidecar_root=_env_path(
                "RAG_LIGHTRAG_SIDECAR_ROOT", "./inputs"
            ),
            graph_working_dir=_env_path(
                "RAG_GRAPH_WORKING_DIR", "./rag_storage_v154"
            ),
            visual_fallback=VisualFallbackSettings.from_env(
                default_cache_root=artifact_root / "visual_fallback_cache"
            ),
        )


class RagWorker:
    def __init__(
        self,
        *,
        settings: WorkerSettings,
        jobs: RagJobStore,
        registry: RagRegistry,
        client: LightRAGClient,
        artifact_store: ArtifactStore,
    ) -> None:
        self._settings = settings
        self._jobs = jobs
        self._registry = registry
        self._client = client
        self._artifact_store = artifact_store
        self._visual_fallback = VisualTextFallback(settings.visual_fallback)

    async def run(self, *, once: bool) -> None:
        while True:
            job = await self._jobs.claim_next(
                self._settings.worker_id, self._settings.lease_seconds
            )
            if job is None:
                if once:
                    return
                await asyncio.sleep(self._settings.poll_seconds)
                continue

            await self._process(job)
            if once:
                return

    async def _process(self, job: RagJob) -> None:
        started_at = time.perf_counter()
        failed = True
        with request_context(job.request_id):
            log_event(
                logger,
                "rag_worker_task_started",
                task_id=str(job.task_id),
                task_type=job.task_type,
                status=job.status,
                attempt=job.attempt,
                worker_id=self._settings.worker_id,
            )
            try:
                if job.cancel_requested_at is not None:
                    await self._cancel(job)
                elif job.task_type in {"ingest", "rebuild"}:
                    await self._process_ingest(job)
                elif job.task_type == "graph":
                    await self._process_graph(job)
                elif job.task_type == "delete":
                    await self._process_delete(job)
                else:
                    raise ValueError(f"Unsupported RAG task type: {job.task_type}")
            except TaskClaimLost as exc:
                failed = False
                log_event(
                    logger,
                    "rag_worker_task_claim_lost",
                    task_id=str(job.task_id),
                    detail=str(exc),
                )
            except RagRegistryRetryableError as exc:
                await self._retry_or_fail(job, str(exc))
            except ValueError as exc:
                await self._fail(job, str(exc))
            except (LightRAGError, VisualFallbackError) as exc:
                await self._retry_or_fail(job, str(exc))
            except Exception as exc:
                logger.exception(
                    "rag_worker_task_unexpected_failure",
                    extra={
                        "rag_fields": {
                            "task_id": str(job.task_id),
                            "task_type": job.task_type,
                            "error_type": exc.__class__.__name__,
                        }
                    },
                )
                await self._retry_or_fail(job, "Unexpected worker failure")
            else:
                failed = False
            finally:
                duration_ms = round(elapsed_ms(started_at), 3)
                metrics.observe(f"worker_{job.task_type}", duration_ms, failed=failed)
                log_event(
                    logger,
                    "rag_worker_task_finished",
                    task_id=str(job.task_id),
                    task_type=job.task_type,
                    failed=failed,
                    duration_ms=duration_ms,
                )

    async def _process_ingest(self, job: RagJob) -> None:
        if job.lightrag_track_id is None:
            source_path = _source_path(job.payload)
            processing_profile = _processing_profile(job.payload)
            upload_name = _required_payload_text(job.payload, "lightrag_upload_name")
            page_routing_manifest_path = self._artifact_store.page_routing_manifest_path(
                _artifact_namespace(job.payload), job.document_id, job.revision
            )
            prepared_upload = await self._visual_fallback.prepare(
                source_path,
                processing_profile,
                upload_name,
                page_routing_manifest_path=page_routing_manifest_path,
            )
            source_path = prepared_upload.path
            upload_name = prepared_upload.upload_name or upload_name
            try:
                response = await self._client.upload(
                    source_path,
                    processing_profile,
                    upload_name=upload_name,
                )
                if response.get("status") not in {"success", "partial_success"}:
                    raise LightRAGError("LightRAG rejected the queued upload")
                track_id = _required_response_text(response, "track_id")
                detail = "LightRAG accepted upload; waiting for vector indexing"
                if prepared_upload.fallback_pages:
                    detail = (
                        "LightRAG accepted Markdown with visual text fallback for "
                        f"{len(prepared_upload.fallback_pages)} page(s); "
                        "waiting for vector indexing"
                    )
            except LightRAGError as exc:
                if "HTTP 409" not in str(exc):
                    raise
                track_id = await self._client.find_track_id_by_filename(upload_name)
                if track_id is None:
                    raise
                detail = "Recovered LightRAG track ID after an interrupted upload"
            await self._jobs.record_track_id(
                job.task_id, track_id, worker_id=self._settings.worker_id
            )
            await self._jobs.reschedule(
                job.task_id,
                "queued",
                self._settings.poll_seconds,
                detail,
                worker_id=self._settings.worker_id,
            )
            return

        status_payload = await self._client.track_status(job.lightrag_track_id)
        documents = _status_documents(status_payload)
        if not documents:
            await self._wait_for_status(job, "LightRAG has not registered the upload yet")
            return
        if _contains_failed_document(documents):
            await self._fail(job, _failure_detail(documents))
            return
        if not all(_vector_ready(document) for document in documents):
            await self._wait_for_status(job, "Waiting for LightRAG vector stage")
            return

        lightrag_document_id = _document_id(documents[0])
        workspace = _task_workspace(job.payload, self._settings.workspace)
        await self._registry.record_lightrag_document(
            job.document_id, job.revision, lightrag_document_id
        )
        capture = await self._registry.capture_lightrag_output(
            job.document_id,
            job.revision,
            workspace,
            lightrag_document_id,
            self._settings.lightrag_sidecar_root,
        )
        links = await self._registry.synchronize_lightrag_chunk_links(
            job.document_id,
            job.revision,
            workspace,
            lightrag_document_id,
        )
        await self._jobs.mark_vector_ready(
            job.task_id,
            "LightRAG persisted vector entries; "
            f"workspace={workspace}, parser_artifacts={capture.artifact_count}, "
            f"parent_chunks={capture.parent_chunks}, child_chunks={capture.child_chunks}, "
            f"lightrag_chunks={links.lightrag_chunks}, "
            f"provenance_links={links.link_count}, primary_links={links.primary_link_count}",
            worker_id=self._settings.worker_id,
            graph_payload={"source_task_id": str(job.task_id), "workspace": workspace},
        )

    async def _process_graph(self, job: RagJob) -> None:
        if not job.lightrag_track_id:
            raise ValueError("Graph task has no LightRAG track ID")
        status_payload = await self._client.track_status(job.lightrag_track_id)
        documents = _status_documents(status_payload)
        if not documents:
            await self._wait_for_status(job, "LightRAG graph stage has not started")
            return
        if _contains_failed_document(documents):
            await self._fail(job, _failure_detail(documents))
            return
        if not all(_graph_ready(document) for document in documents):
            await self._wait_for_status(job, "Waiting for LightRAG entity and relation extraction")
            return
        workspace = _task_workspace(job.payload, self._settings.workspace)
        facts = await self._registry.synchronize_graph_facts(
            job.document_id,
            job.revision,
            workspace,
            self._settings.graph_working_dir,
        )
        await self._jobs.mark_graph_ready(
            job.task_id,
            "LightRAG completed entity and relation extraction; "
            f"workspace={workspace}, relation_chunks={facts.relation_count}, "
            f"graph_facts={facts.fact_count}",
            worker_id=self._settings.worker_id,
        )

    async def _process_delete(self, job: RagJob) -> None:
        manifest = await self._registry.build_deletion_manifest(job.document_id)
        if manifest.lightrag_document_ids:
            response = await self._client.delete_documents(
                list(manifest.lightrag_document_ids),
                delete_files=bool(job.payload.get("delete_files", False)),
                delete_llm_cache=bool(job.payload.get("delete_llm_cache", False)),
            )
            if response.get("status") not in {
                "success",
                "partial_success",
                "deletion_started",
            }:
                raise LightRAGError("LightRAG did not confirm document deletion")
        await self._registry.finalize_document_deletion(manifest)
        await self._jobs.mark_graph_ready(
            job.task_id,
            "LightRAG, registry metadata, and retained artifacts were deleted",
            worker_id=self._settings.worker_id,
        )

    async def _cancel(self, job: RagJob) -> None:
        detail = "Task cancelled before LightRAG accepted the upload"
        if (
            job.task_type in {"ingest", "rebuild"}
            and job.lightrag_track_id
            and self._settings.allow_pipeline_cancel
        ):
            try:
                response = await self._client.cancel_pipeline()
                detail = f"LightRAG cancellation requested: {response.get('status', 'unknown')}"
            except LightRAGError as exc:
                detail = f"Task cancelled; LightRAG cancellation was not confirmed: {exc}"
        await self._jobs.mark_cancelled(
            job.task_id, detail, worker_id=self._settings.worker_id
        )

    async def _wait_for_status(self, job: RagJob, detail: str) -> None:
        next_status = "kg_pending" if job.task_type == "graph" else "queued"
        await self._jobs.reschedule(
            job.task_id,
            next_status,
            self._settings.poll_seconds,
            detail,
            worker_id=self._settings.worker_id,
        )

    async def _retry_or_fail(self, job: RagJob, detail: str) -> None:
        if job.attempt + 1 >= self._settings.max_attempts:
            await self._fail(job, detail)
            return
        next_status = "kg_pending" if job.task_type == "graph" else "queued"
        delay_seconds = min(
            self._settings.retry_max_seconds,
            self._settings.retry_base_seconds * (2**job.attempt),
        )
        await self._jobs.reschedule(
            job.task_id,
            next_status,
            delay_seconds,
            detail,
            worker_id=self._settings.worker_id,
            increment_attempt=True,
        )

    async def _fail(self, job: RagJob, detail: str) -> None:
        try:
            await self._jobs.mark_failed(
                job.task_id, detail, worker_id=self._settings.worker_id
            )
        except TaskClaimLost as exc:
            log_event(
                logger,
                "rag_worker_failure_update_skipped",
                task_id=str(job.task_id),
                detail=str(exc),
            )


def _source_path(payload: dict[str, Any]) -> Path:
    source_uri = _required_payload_text(payload, "source_uri")
    parsed_uri = urlparse(source_uri)
    if parsed_uri.scheme != "file" or parsed_uri.netloc not in {"", "localhost"}:
        raise ValueError("RAG task source_uri must be a local file URI")
    source_path = Path(url2pathname(unquote(parsed_uri.path))).resolve()
    if not source_path.is_file():
        raise ValueError("RAG task source artifact is unavailable to this worker")
    return source_path


def _processing_profile(payload: dict[str, Any]) -> ProcessingProfile:
    value = _required_payload_text(payload, "processing_profile")
    if value not in {"text", "visual", "table", "full"}:
        raise ValueError("RAG task processing_profile is invalid")
    return value  # type: ignore[return-value]


def _artifact_namespace(payload: dict[str, Any]) -> str:
    value = payload.get(
        "artifact_namespace",
        os.getenv("RAG_PRODUCTION_ARTIFACT_NAMESPACE", "production"),
    )
    if not isinstance(value, str) or not value.strip():
        raise ValueError("RAG task payload artifact_namespace is invalid")
    return value.strip()


def _task_workspace(payload: dict[str, Any], default: str) -> str:
    value = payload.get("workspace", default)
    if not isinstance(value, str) or not value.strip():
        raise ValueError("RAG task payload workspace is invalid")
    return value.strip()


def _required_payload_text(payload: dict[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"RAG task payload is missing {key}")
    return value.strip()


def _required_response_text(payload: dict[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise LightRAGError(f"LightRAG response did not include {key}")
    return value.strip()


def _status_documents(payload: dict[str, Any]) -> list[dict[str, Any]]:
    documents = payload.get("documents")
    if not isinstance(documents, list):
        raise LightRAGError("LightRAG track status did not include documents")
    return [document for document in documents if isinstance(document, dict)]


def _status(document: dict[str, Any]) -> str:
    value = document.get("status")
    return value.strip().lower() if isinstance(value, str) else ""


def _contains_failed_document(documents: list[dict[str, Any]]) -> bool:
    return any(_status(document) == "failed" for document in documents)


def _vector_ready(document: dict[str, Any]) -> bool:
    status = _status(document)
    if status in {"processed", "preprocessed"}:
        return True
    return status == "processing" and isinstance(document.get("chunks_count"), int)


def _graph_ready(document: dict[str, Any]) -> bool:
    return _status(document) == "processed"


def _document_id(document: dict[str, Any]) -> str:
    value = document.get("id")
    if not isinstance(value, str) or not value.strip():
        raise LightRAGError("LightRAG track status did not include a document ID")
    return value.strip()


def _failure_detail(documents: list[dict[str, Any]]) -> str:
    for document in documents:
        if _status(document) == "failed":
            detail = document.get("error_msg")
            if isinstance(detail, str) and detail.strip():
                return detail.strip()[:4000]
    return "LightRAG marked the document as failed"


async def _run_worker(*, once: bool) -> None:
    worker_settings = WorkerSettings.from_env()
    gateway_settings = GatewaySettings.from_env()
    if worker_settings.lease_seconds <= gateway_settings.request_timeout_seconds:
        raise ValueError(
            "RAG_WORKER_LEASE_SECONDS must exceed RAG_REQUEST_TIMEOUT_SECONDS"
        )
    pool = await create_postgres_pool(PostgresSettings.from_env())
    client = LightRAGClient(gateway_settings)
    artifact_store = ArtifactStore.from_env()
    registry = RagRegistry(pool, artifact_store, ParserIsolation.from_env())
    worker = RagWorker(
        settings=worker_settings,
        jobs=RagJobStore(pool),
        registry=registry,
        client=client,
        artifact_store=artifact_store,
    )
    try:
        log_event(
            logger,
            "rag_worker_started",
            worker_id=worker_settings.worker_id,
            once=once,
        )
        await worker.run(once=once)
    finally:
        await client.close()
        await pool.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run the durable RAG worker")
    parser.add_argument(
        "--once",
        action="store_true",
        help="Claim and process at most one ready task, then exit",
    )
    arguments = parser.parse_args()
    asyncio.run(_run_worker(once=arguments.once))
