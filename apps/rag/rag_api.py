"""Canonical REST facade and MCP host for the local LightRAG gateway."""

from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path

APP_RAG_DIR = Path(__file__).resolve().parent
if str(APP_RAG_DIR) not in sys.path:
    sys.path.insert(0, str(APP_RAG_DIR))
from contextlib import asynccontextmanager
from typing import Any, Literal

from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

import gateway
from lightrag_client import LightRAGError, ProcessingProfile
from rag_observability import request_context


class RetrievalRequest(BaseModel):
    query: str = Field(min_length=3, max_length=20_000)
    mode: Literal["local", "global", "hybrid", "naive", "mix"] = "mix"
    top_k: int = Field(default=10, ge=1, le=200)
    chunk_top_k: int = Field(default=10, ge=1, le=200)
    max_total_tokens: int = Field(default=8000, ge=256, le=200_000)
    enable_rerank: bool = True


class ImportRequest(BaseModel):
    file_path: str = Field(min_length=1, max_length=16_384)
    processing_profile: ProcessingProfile = "text"
    force_new_revision: bool = False


class DeleteDocumentsRequest(BaseModel):
    document_ids: list[str] = Field(min_length=1, max_length=200)
    delete_files: bool = False
    delete_llm_cache: bool = False


def _request_id(request: Request) -> str:
    supplied = request.headers.get("X-Request-ID", "").strip()
    return supplied[:128] if supplied else str(uuid.uuid4())


def _safe_detail(error: LightRAGError) -> str:
    message = str(error)
    safe_prefixes = (
        "query ",
        "task_id ",
        "document_ids ",
        "file_name ",
        "file_path ",
        "Ingest path ",
        "Ingest file ",
        "Unknown processing_profile",
    )
    if message.startswith(safe_prefixes):
        return message
    return "RAG request failed. Check the local service logs for details."


def _require_confirmation(confirmed: str | None) -> None:
    if confirmed is None or confirmed.strip().lower() != "true":
        raise HTTPException(
            status_code=428,
            detail="Set X-Desktop-Confirmed: true after explicit user confirmation.",
        )


async def _invoke(request: Request, function, **kwargs: Any) -> dict[str, Any]:
    request_id = _request_id(request)
    try:
        with request_context(request_id):
            return await function(request_id=request_id, **kwargs)
    except LightRAGError as exc:
        raise HTTPException(status_code=400, detail=_safe_detail(exc)) from exc


@asynccontextmanager
async def lifespan(_: FastAPI):
    # FastMCP's ASGI app requires its session manager to be active when mounted.
    async with gateway.mcp.session_manager.run():
        try:
            yield
        finally:
            await gateway.close_gateway_resources()


app = FastAPI(
    title="Local LightRAG Gateway API",
    version="0.1.0",
    lifespan=lifespan,
)

allowed_origins = [
    origin.strip()
    for origin in os.getenv(
        "RAG_WEB_ALLOWED_ORIGINS",
        "http://127.0.0.1:5173,http://localhost:5173,null",
    ).split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "X-Request-ID", "X-Desktop-Confirmed"],
)


@app.exception_handler(LightRAGError)
async def lightrag_error_handler(_: Request, exc: LightRAGError) -> JSONResponse:
    return JSONResponse(status_code=400, content={"detail": _safe_detail(exc)})


@app.get("/api/v1/rag/health")
async def rag_health(request: Request) -> dict[str, Any]:
    return await _invoke(request, gateway.rag_health)


@app.get("/api/v1/rag/ready", response_model=None)
async def rag_ready(request: Request) -> Any:
    report = await _invoke(request, gateway.rag_ready)
    if report.get("status") != "ready":
        return JSONResponse(status_code=503, content=report)
    return report


@app.post("/api/v1/rag/retrievals")
async def rag_retrieve(request: Request, payload: RetrievalRequest) -> dict[str, Any]:
    return await _invoke(
        request,
        gateway.rag_retrieve,
        query=payload.query,
        mode=payload.mode,
        top_k=payload.top_k,
        chunk_top_k=payload.chunk_top_k,
        max_total_tokens=payload.max_total_tokens,
        enable_rerank=payload.enable_rerank,
    )


@app.post("/api/v1/rag/answers")
async def rag_answer(request: Request, payload: RetrievalRequest) -> dict[str, Any]:
    return await _invoke(
        request,
        gateway.rag_answer,
        query=payload.query,
        mode=payload.mode,
        top_k=payload.top_k,
        chunk_top_k=payload.chunk_top_k,
        max_total_tokens=payload.max_total_tokens,
        enable_rerank=payload.enable_rerank,
    )


@app.get("/api/v1/rag/pipeline")
async def rag_pipeline_status(request: Request) -> dict[str, Any]:
    return await _invoke(request, gateway.rag_pipeline_status)


@app.get("/api/v1/rag/lightrag-documents")
async def rag_list_documents(
    request: Request,
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
    | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=10, le=200),
    sort_field: Literal["created_at", "updated_at", "id", "file_path"] = "updated_at",
    sort_direction: Literal["asc", "desc"] = "desc",
) -> dict[str, Any]:
    return await _invoke(
        request,
        gateway.rag_list_documents,
        statuses=statuses,
        page=page,
        page_size=page_size,
        sort_field=sort_field,
        sort_direction=sort_direction,
    )


@app.get("/api/v1/rag/documents")
async def rag_list_registry_documents(
    request: Request,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=10, le=200),
) -> dict[str, Any]:
    return await _invoke(
        request,
        gateway.rag_list_registry_documents,
        page=page,
        page_size=page_size,
    )


@app.post("/api/v1/rag/imports", status_code=202)
async def rag_import(request: Request, payload: ImportRequest) -> dict[str, Any]:
    response = await _invoke(
        request,
        gateway.rag_ingest,
        file_path=payload.file_path,
        processing_profile=payload.processing_profile,
        force_new_revision=payload.force_new_revision,
    )
    if response.get("disposition") == "idempotent":
        return JSONResponse(status_code=200, content=response)
    return response


@app.get("/api/v1/rag/tasks/{task_id}")
async def rag_task_status(request: Request, task_id: str) -> dict[str, Any]:
    return await _invoke(request, gateway.rag_task_status, task_id=task_id)


@app.post("/api/v1/rag/tasks/{task_id}:cancel", status_code=202)
async def rag_cancel_task(
    request: Request,
    task_id: str,
    confirmed: str | None = Header(default=None, alias="X-Desktop-Confirmed"),
) -> dict[str, Any]:
    _require_confirmation(confirmed)
    return await _invoke(request, gateway.rag_cancel_task, task_id=task_id)


@app.post("/api/v1/rag/tasks/{task_id}:retry", status_code=202)
async def rag_retry_task(request: Request, task_id: str) -> dict[str, Any]:
    return await _invoke(request, gateway.rag_retry_task, task_id=task_id)


@app.post("/api/v1/rag/documents:delete", status_code=202)
async def rag_delete_documents(
    request: Request,
    payload: DeleteDocumentsRequest,
    confirmed: str | None = Header(default=None, alias="X-Desktop-Confirmed"),
) -> dict[str, Any]:
    _require_confirmation(confirmed)
    return await _invoke(
        request,
        gateway.rag_delete_documents,
        document_ids=payload.document_ids,
        delete_files=payload.delete_files,
        delete_llm_cache=payload.delete_llm_cache,
    )


# Register REST routes before the FastMCP sub-application, which owns /mcp.
app.mount("/", gateway.mcp.streamable_http_app())


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.getenv("RAG_MCP_HOST", "127.0.0.1"),
        port=int(os.getenv("RAG_MCP_PORT", "8001")),
        log_level=os.getenv("RAG_LOG_LEVEL", "info").lower(),
    )
