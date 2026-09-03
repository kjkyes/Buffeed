from __future__ import annotations

import argparse
import asyncio
import functools
import inspect
import json
import os
import time

from typing import Any, Literal
from uuid import UUID

import rag_config  # noqa: F401 - load the active profile before LightRAG imports
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

from hybrid_retrieval import HybridRetriever
from lightrag_client import (
    GatewaySettings,
    LightRAGClient,
    LightRAGError,
    ProcessingProfile,
    encode_track_id,
    probe_docling_service,
)
from rag_database import probe_postgres
from rag_config import ACTIVE_PROFILE
from source_layout import source_metadata
from rag_jobs import RagJob, RagJobStore
from rag_observability import (
    configure_logging,
    elapsed_ms,
    get_request_id,
    log_event,
    metrics,
    request_context,
)
from rag_registry import ArtifactStore, IngestRequest, RagRegistry


logger = configure_logging("rag_gateway")
settings = GatewaySettings.from_env()
query_slots = asyncio.Semaphore(settings.query_concurrency)
write_lock = asyncio.Lock()
client: LightRAGClient | None = None
hybrid_retriever: HybridRetriever | None = None
hybrid_retriever_lock = asyncio.Lock()
registry: RagRegistry | None = None
registry_lock = asyncio.Lock()
job_store: RagJobStore | None = None

READ_ONLY = ToolAnnotations(
    readOnlyHint=True,
    destructiveHint=False,
    idempotentHint=True,
    openWorldHint=False,
)
ADDITIVE_WRITE = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=False,
    idempotentHint=False,
    openWorldHint=False,
)
DESTRUCTIVE_WRITE = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=True,
    idempotentHint=False,
    openWorldHint=False,
)


def get_client() -> LightRAGClient:
    global client
    if client is None:
        client = LightRAGClient(settings)
    return client


async def get_hybrid_retriever() -> HybridRetriever:
    global hybrid_retriever
    if hybrid_retriever is None:
        async with hybrid_retriever_lock:
            if hybrid_retriever is None:
                hybrid_retriever = HybridRetriever.from_env(get_client())
    return hybrid_retriever


async def get_registry() -> RagRegistry:
    global registry
    if registry is None:
        async with registry_lock:
            if registry is None:
                registry = await RagRegistry.connect_from_env()
    return registry


async def get_job_store() -> RagJobStore:
    global job_store
    if job_store is None:
        job_store = RagJobStore((await get_registry()).pool)
    return job_store


async def close_gateway_resources() -> None:
    """Close lazy shared resources when the combined HTTP application stops."""
    global client, hybrid_retriever, registry, job_store
    active_hybrid = hybrid_retriever
    active_registry = registry
    active_client = client
    hybrid_retriever = None
    registry = None
    client = None
    job_store = None

    close_operations = []
    if active_hybrid is not None:
        close_operations.append(active_hybrid.close())
    if active_registry is not None:
        close_operations.append(active_registry.close())
    if active_client is not None:
        close_operations.append(active_client.close())
    if not close_operations:
        return
    results = await asyncio.gather(*close_operations, return_exceptions=True)
    for result in results:
        if isinstance(result, Exception):
            log_event(
                logger,
                "rag_gateway_resource_close_failed",
                error_type=result.__class__.__name__,
            )


def _task_response(job: RagJob) -> dict[str, Any]:
    return {
        "task_id": str(job.task_id),
        "document_id": str(job.document_id),
        "revision": job.revision,
        "task_type": job.task_type,
        "status": job.status,
        "attempt": job.attempt,
        "lightrag_track_id": job.lightrag_track_id,
        "error_detail": job.error_detail,
        "parent_task_id": str(job.parent_task_id) if job.parent_task_id else None,
        "cancel_requested": job.cancel_requested_at is not None,
        "request_id": job.request_id,
    }


def _page_routing_manifest(job: RagJob) -> dict[str, Any] | None:
    namespace = job.payload.get(
        "artifact_namespace",
        os.getenv("RAG_PRODUCTION_ARTIFACT_NAMESPACE", "production"),
    )
    if not isinstance(namespace, str) or not namespace.strip():
        return None
    try:
        manifest_path = ArtifactStore.from_env().page_routing_manifest_path(
            namespace.strip(), job.document_id, job.revision
        )
    except ValueError:
        return None
    if not manifest_path.is_file():
        return None
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _parse_task_id(task_id: str) -> UUID:
    try:
        return UUID(task_id.strip())
    except (AttributeError, ValueError) as exc:
        raise LightRAGError("task_id must be a UUID") from exc


def observed_tool(tool_name: str):
    def decorate(function):
        function_signature = inspect.signature(function)

        @functools.wraps(function)
        async def wrapped(*args: Any, **kwargs: Any) -> dict[str, Any]:
            started_at = time.perf_counter()
            failed = True
            try:
                provided_request_id = function_signature.bind_partial(
                    *args, **kwargs
                ).arguments.get("request_id")
                with request_context(provided_request_id) as request_id:
                    log_event(logger, "rag_tool_started", tool_name=tool_name)
                    try:
                        payload = await function(*args, **kwargs)
                    except Exception as exc:
                        log_event(
                            logger,
                            "rag_tool_failed",
                            tool_name=tool_name,
                            duration_ms=round(elapsed_ms(started_at), 3),
                            error_type=exc.__class__.__name__,
                        )
                        raise
                    failed = False
                    duration_ms = round(elapsed_ms(started_at), 3)
                    log_event(
                        logger,
                        "rag_tool_completed",
                        tool_name=tool_name,
                        duration_ms=duration_ms,
                    )
                    return {**payload, "request_id": request_id}
            finally:
                metrics.observe(tool_name, elapsed_ms(started_at), failed=failed)

        return wrapped

    return decorate


mcp = FastMCP(
    name="local-lightrag",
    instructions="Local LightRAG 1.5.4 retrieval and document management Gateway.",
    host=os.getenv("RAG_MCP_HOST", "127.0.0.1"),
    port=int(os.getenv("RAG_MCP_PORT", "8001")),
    streamable_http_path=os.getenv("RAG_MCP_PATH", "/mcp"),
)


def _query_payload(
    query: str,
    mode: str,
    top_k: int,
    chunk_top_k: int,
    max_total_tokens: int,
    enable_rerank: bool,
) -> dict[str, Any]:
    normalized_query = query.strip()
    if len(normalized_query) < 3:
        raise LightRAGError("query must contain at least 3 characters")
    return {
        "query": normalized_query,
        "mode": mode,
        "top_k": min(max(1, top_k), settings.max_top_k),
        "chunk_top_k": min(max(1, chunk_top_k), settings.max_chunk_top_k),
        "max_total_tokens": min(
            max(256, max_total_tokens), settings.max_total_tokens
        ),
        "enable_rerank": enable_rerank,
    }


def _safe_configuration(payload: dict[str, Any]) -> dict[str, Any]:
    configuration = payload.get("configuration") or {}
    return {
        key: configuration.get(key)
        for key in (
            "llm_binding",
            "llm_model",
            "embedding_binding",
            "embedding_model",
            "workspace",
            "parser_routing",
            "docling",
            "enable_rerank",
            "rerank_binding",
            "rerank_model",
        )
        if key in configuration
    }


def _postgres_required() -> bool:
    configured = os.getenv("RAG_POSTGRES_REQUIRED", "").strip().lower()
    if configured in {"1", "true", "yes", "on"}:
        return True
    if configured in {"0", "false", "no", "off"}:
        return False
    storage_keys = (
        "LIGHTRAG_KV_STORAGE",
        "LIGHTRAG_VECTOR_STORAGE",
        "LIGHTRAG_DOC_STATUS_STORAGE",
        "LIGHTRAG_GRAPH_STORAGE",
    )
    return os.getenv("RAG_HYBRID_POSTGRES_ENABLED", "false").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    } or any(
        os.getenv(key, "").strip().startswith("PG") for key in storage_keys
    )


@mcp.tool(
    description="Check LightRAG health without exposing API keys or local storage paths.",
    annotations=READ_ONLY,
)
@observed_tool("rag_health")
async def rag_health(request_id: str | None = None) -> dict[str, Any]:
    payload = await get_client().request("GET", "/health")
    docling_service = await probe_docling_service(settings)
    return {
        "status": payload.get("status"),
        "core_version": payload.get("core_version"),
        "api_version": payload.get("api_version"),
        "auth_mode": payload.get("auth_mode"),
        "pipeline_active": payload.get("pipeline_active"),
        "configuration": _safe_configuration(payload),
        "docling_service": docling_service,
        "implementation": "apps/rag",
        "source_mode": source_metadata()["source_mode"],
    }


async def _probe_lightrag_readiness() -> dict[str, Any]:
    try:
        payload = await asyncio.wait_for(
            get_client().request("GET", "/health"),
            timeout=settings.readiness_timeout_seconds,
        )
    except asyncio.TimeoutError:
        return {
            "configured": True,
            "reachable": False,
            "error": "TimeoutError",
        }
    except LightRAGError as exc:
        return {
            "configured": True,
            "reachable": False,
            "error": exc.__class__.__name__,
        }

    return {
        "configured": True,
        "reachable": payload.get("status") == "healthy",
        "status": payload.get("status"),
        "core_version": payload.get("core_version"),
        "api_version": payload.get("api_version"),
        "configuration": _safe_configuration(payload),
    }


@mcp.tool(
    description="Check whether LightRAG, PostgreSQL, and Docling are ready for RAG operations.",
    annotations=READ_ONLY,
)
@observed_tool("rag_ready")
async def rag_ready(request_id: str | None = None) -> dict[str, Any]:
    async def bounded_postgres_probe() -> dict[str, Any]:
        try:
            return await asyncio.wait_for(
                probe_postgres(), timeout=settings.readiness_timeout_seconds
            )
        except asyncio.TimeoutError:
            return {
                "configured": True,
                "reachable": False,
                "ssl_mode": None,
                "error": "TimeoutError",
            }

    lightrag_service, postgres_service, docling_service = await asyncio.gather(
        _probe_lightrag_readiness(),
        bounded_postgres_probe(),
        probe_docling_service(settings),
    )
    lightrag_ready = bool(lightrag_service.get("reachable"))
    postgres_ready = bool(postgres_service.get("reachable"))
    docling_ready = bool(docling_service.get("reachable"))
    postgres_required = _postgres_required()
    ready = lightrag_ready and docling_ready and (
        not postgres_required or postgres_ready
    )
    return {
        "status": "ready" if ready else "not_ready",
        "process_ready": True,
        "active_profile": ACTIVE_PROFILE,
        "postgres_required": postgres_required,
        "lightrag_ready": lightrag_ready,
        "postgres_ready": postgres_ready,
        "docling_ready": docling_ready,
        "checks": {
            "lightrag": lightrag_service,
            "postgres": postgres_service,
            "docling": docling_service,
        },
    }


@mcp.tool(
    description="Retrieve structured entities, relationships, chunks, and references. Use this before answering from local knowledge.",
    annotations=READ_ONLY,
)
@observed_tool("rag_retrieve")
async def rag_retrieve(
    query: str,
    mode: Literal["local", "global", "hybrid", "naive", "mix"] = "mix",
    top_k: int = 10,
    chunk_top_k: int = 10,
    max_total_tokens: int = 8000,
    enable_rerank: bool = True,
    request_id: str | None = None,
) -> dict[str, Any]:
    request_payload = _query_payload(
        query, mode, top_k, chunk_top_k, max_total_tokens, enable_rerank
    )
    async with query_slots:
        hybrid = await get_hybrid_retriever()
        if hybrid.enabled:
            payload = await hybrid.retrieve(
                request_payload["query"],
                top_k=request_payload["top_k"],
                chunk_top_k=request_payload["chunk_top_k"],
                max_total_tokens=request_payload["max_total_tokens"],
                enable_rerank=request_payload["enable_rerank"],
            )
            payload["requested_mode"] = mode
        else:
            payload = await get_client().request(
                "POST", "/query/data", json=request_payload
            )
    return get_client().bounded_payload(payload)


@mcp.tool(
    description="Ask LightRAG to generate an answer. Prefer rag_retrieve when the Agent can generate the final answer itself.",
    annotations=READ_ONLY,
)
@observed_tool("rag_answer")
async def rag_answer(
    query: str,
    mode: Literal["local", "global", "hybrid", "naive", "mix"] = "mix",
    top_k: int = 10,
    chunk_top_k: int = 10,
    max_total_tokens: int = 8000,
    enable_rerank: bool = True,
    request_id: str | None = None,
) -> dict[str, Any]:
    request_payload = _query_payload(
        query, mode, top_k, chunk_top_k, max_total_tokens, enable_rerank
    )
    request_payload.update(
        {"include_references": True, "include_chunk_content": False, "stream": False}
    )
    async with query_slots:
        payload = await get_client().request("POST", "/query", json=request_payload)
    return get_client().bounded_payload(payload)


@mcp.tool(
    description="Get the current LightRAG indexing pipeline status.",
    annotations=READ_ONLY,
)
@observed_tool("rag_pipeline_status")
async def rag_pipeline_status(request_id: str | None = None) -> dict[str, Any]:
    payload = await get_client().request("GET", "/documents/pipeline_status")
    return get_client().bounded_payload(payload)


@mcp.tool(
    description="Get document processing status for a LightRAG tracking ID.",
    annotations=READ_ONLY,
)
@observed_tool("rag_job_status")
async def rag_job_status(
    track_id: str, request_id: str | None = None
) -> dict[str, Any]:
    payload = await get_client().request(
        "GET", f"/documents/track_status/{encode_track_id(track_id)}"
    )
    return get_client().bounded_payload(payload)


@mcp.tool(
    description="List indexed documents with pagination and optional status filtering.",
    annotations=READ_ONLY,
)
@observed_tool("rag_list_documents")
async def rag_list_documents(
    statuses: list[
        Literal[
            "pending",
            "parsing",
            "analyzing",
            "processing",
            "preprocessed",
            "processed",
            "failed",
        ]
    ]
    | None = None,
    page: int = 1,
    page_size: int = 50,
    sort_field: Literal["created_at", "updated_at", "id", "file_path"] = "updated_at",
    sort_direction: Literal["asc", "desc"] = "desc",
    request_id: str | None = None,
) -> dict[str, Any]:
    request_payload = {
        "status_filters": statuses or None,
        "page": max(1, page),
        "page_size": min(max(10, page_size), 200),
        "sort_field": sort_field,
        "sort_direction": sort_direction,
    }
    payload = await get_client().request(
        "POST", "/documents/paginated", json=request_payload
    )
    return get_client().bounded_payload(payload)


@mcp.tool(
    description="List active registry documents with stable IDs for management operations.",
    annotations=READ_ONLY,
)
@observed_tool("rag_list_registry_documents")
async def rag_list_registry_documents(
    page: int = 1,
    page_size: int = 50,
    request_id: str | None = None,
) -> dict[str, Any]:
    try:
        return await (await get_registry()).list_documents(page=page, page_size=page_size)
    except ValueError as exc:
        raise LightRAGError(str(exc)) from exc


@mcp.tool(
    description=(
        "Register one local file for durable background indexing. The persistent "
        "worker uploads it to LightRAG after the request has been recorded."
    ),
    annotations=ADDITIVE_WRITE,
)
@observed_tool("rag_ingest")
async def rag_ingest(
    file_path: str,
    processing_profile: ProcessingProfile = "text",
    force_new_revision: bool = False,
    request_id: str | None = None,
) -> dict[str, Any]:
    source = get_client().resolve_ingest_file(file_path)
    async with write_lock:
        try:
            registration = await (await get_registry()).register_ingest(
                IngestRequest(
                    source_path=source,
                    source_key=source.as_uri(),
                    parser_name="docling",
                    workspace=settings.workspace
                    or os.getenv("RAG_PRODUCTION_WORKSPACE", "default"),
                    artifact_namespace=os.getenv(
                        "RAG_PRODUCTION_ARTIFACT_NAMESPACE", "production"
                    ),
                    processing_profile=processing_profile,
                    force_new_revision=force_new_revision,
                    request_id=get_request_id(),
                )
            )
        except ValueError as exc:
            raise LightRAGError(str(exc)) from exc
    return {
        "disposition": registration.disposition,
        "document_id": str(registration.document_id),
        "revision": registration.revision,
        "task_id": str(registration.task_id) if registration.task_id else None,
    }


@mcp.tool(
    description="Get durable RAG task state and its transition audit trail.",
    annotations=READ_ONLY,
)
@observed_tool("rag_task_status")
async def rag_task_status(
    task_id: str, request_id: str | None = None
) -> dict[str, Any]:
    parsed_task_id = _parse_task_id(task_id)
    try:
        jobs = await get_job_store()
        task = await jobs.get(parsed_task_id)
        events = await jobs.events(parsed_task_id)
        children = await jobs.children(parsed_task_id)
    except ValueError as exc:
        raise LightRAGError(str(exc)) from exc
    return {
        "task": _task_response(task),
        "events": events,
        "children": [_task_response(child) for child in children],
        "page_routing": await asyncio.to_thread(_page_routing_manifest, task),
    }


@mcp.tool(
    description="Request cancellation of one durable RAG task.",
    annotations=DESTRUCTIVE_WRITE,
)
@observed_tool("rag_cancel_task")
async def rag_cancel_task(
    task_id: str, request_id: str | None = None
) -> dict[str, Any]:
    parsed_task_id = _parse_task_id(task_id)
    async with write_lock:
        try:
            task = await (await get_job_store()).cancel(parsed_task_id)
        except ValueError as exc:
            raise LightRAGError(str(exc)) from exc
    return _task_response(task)


@mcp.tool(
    description="Retry one failed or cancelled durable RAG task.",
    annotations=ADDITIVE_WRITE,
)
@observed_tool("rag_retry_task")
async def rag_retry_task(
    task_id: str, request_id: str | None = None
) -> dict[str, Any]:
    parsed_task_id = _parse_task_id(task_id)
    async with write_lock:
        try:
            task = await (await get_job_store()).retry(parsed_task_id)
        except ValueError as exc:
            raise LightRAGError(str(exc)) from exc
    return _task_response(task)


@mcp.tool(
    description="Submit registry documents for unified background deletion by document UUID.",
    annotations=DESTRUCTIVE_WRITE,
)
@observed_tool("rag_delete_documents")
async def rag_delete_documents(
    document_ids: list[str],
    delete_files: bool = False,
    delete_llm_cache: bool = False,
    request_id: str | None = None,
) -> dict[str, Any]:
    normalized_ids = [item.strip() for item in document_ids if item.strip()]
    if not normalized_ids:
        raise LightRAGError("document_ids cannot be empty")
    if len(normalized_ids) != len(set(normalized_ids)):
        raise LightRAGError("document_ids must be unique")

    try:
        parsed_ids = [UUID(item) for item in normalized_ids]
    except ValueError as exc:
        raise LightRAGError("document_ids must contain registry UUIDs") from exc
    if len(parsed_ids) != len(set(parsed_ids)):
        raise LightRAGError("document_ids must be unique")

    async with write_lock:
        try:
            jobs = await get_job_store()
            tasks = [
                await jobs.submit_delete(
                    document_id,
                    delete_files=delete_files,
                    delete_llm_cache=delete_llm_cache,
                )
                for document_id in parsed_ids
            ]
        except ValueError as exc:
            raise LightRAGError(str(exc)) from exc
    return {"tasks": [_task_response(task) for task in tasks]}


@mcp.tool(
    description="Return bounded in-process Gateway request metrics.",
    annotations=READ_ONLY,
)
@observed_tool("rag_metrics")
async def rag_metrics(request_id: str | None = None) -> dict[str, Any]:
    return metrics.snapshot()


async def _run_preflight() -> dict[str, Any]:
    try:
        report = await rag_ready()
        if report.get("status") != "ready":
            raise LightRAGError("RAG readiness preflight failed")
        return report
    finally:
        if client is not None:
            await client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Run the local LightRAG MCP Gateway."
    )
    parser.add_argument(
        "--preflight",
        action="store_true",
        help="Check LightRAG and the configured Docling Serve sidecar, then exit.",
    )
    args = parser.parse_args()

    if args.preflight:
        try:
            print(json.dumps(asyncio.run(_run_preflight()), ensure_ascii=False))
        except LightRAGError as exc:
            raise SystemExit(f"RAG preflight failed: {exc}") from exc
        raise SystemExit(0)

    transport = os.getenv("RAG_MCP_TRANSPORT", "stdio")
    if transport not in {"stdio", "sse", "streamable-http"}:
        raise SystemExit(
            "RAG_MCP_TRANSPORT must be stdio, sse, or streamable-http"
        )
    mcp.run(transport=transport)
