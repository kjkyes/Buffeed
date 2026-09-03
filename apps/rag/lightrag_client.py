from __future__ import annotations

import copy
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Literal
from urllib.parse import quote, urlparse

import httpx

from rag_observability import configure_logging, elapsed_ms, get_request_id, log_event


logger = configure_logging("rag_lightrag_client")


class LightRAGError(RuntimeError):
    pass


ProcessingProfile = Literal["text", "visual", "table", "full"]
IngestPathMode = Literal["auto", "host", "container"]

DEFAULT_INGEST_CONTAINER_DIR = "/srv/rag/ingest"

_PROCESSING_PROFILE_HINTS: dict[ProcessingProfile, str] = {
    "text": "docling-R",
    "visual": "docling-iR",
    "table": "docling-tR",
    "full": "docling-iteR",
}


def processing_profile_filename(
    file_path: Path,
    processing_profile: ProcessingProfile,
    upload_name: str | None = None,
) -> str:
    try:
        parser_hint = _PROCESSING_PROFILE_HINTS[processing_profile]
    except KeyError as exc:
        allowed_profiles = ", ".join(_PROCESSING_PROFILE_HINTS)
        raise LightRAGError(
            f"Unknown processing_profile {processing_profile!r}; "
            f"expected one of: {allowed_profiles}"
        ) from exc
    source_name = file_path.name if upload_name is None else upload_name.strip()
    if not source_name or Path(source_name).name != source_name:
        raise LightRAGError("upload_name must be a file name without path components")
    suffix = Path(source_name).suffix or file_path.suffix
    return f"{Path(source_name).stem}.[{parser_hint}]{suffix}"


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


def _optional_http_url(name: str) -> str | None:
    raw_value = os.getenv(name, "").strip().rstrip("/")
    if not raw_value:
        return None
    parsed_url = urlparse(raw_value)
    if parsed_url.scheme not in {"http", "https"} or not parsed_url.netloc:
        raise ValueError(f"{name} must be an http or https URL")
    return raw_value


def _parse_allowed_roots(raw_value: str) -> tuple[Path, ...]:
    return tuple(
        Path(item.strip()).expanduser().resolve()
        for item in raw_value.split(os.pathsep)
        if item.strip()
    )


def _parse_ingest_mode(raw_value: str | None) -> IngestPathMode:
    # ``auto`` remains host-first while retaining a bounded alias for older
    # clients; Compose should set ``container`` explicitly.
    mode = (raw_value or "auto").strip().lower()
    if mode == "auto":
        return "auto"
    if mode == "host":
        return "host"
    if mode == "container":
        return "container"
    raise ValueError("RAG_INGEST_MODE must be auto, host, or container")


def _container_relative_path(raw_value: str, container_root: str) -> Path | None:
    """Return a safe relative suffix for a logical container ingest path."""
    normalized_value = raw_value.strip().replace("\\", "/")
    normalized_root = container_root.strip().replace("\\", "/").rstrip("/")
    if not normalized_value.startswith("/") or not normalized_root.startswith("/"):
        return None
    try:
        relative = PurePosixPath(normalized_value).relative_to(
            PurePosixPath(normalized_root)
        )
    except ValueError:
        return None
    if not relative.parts or any(part in {"", ".", ".."} for part in relative.parts):
        return None
    return Path(*relative.parts)


@dataclass(frozen=True)
class GatewaySettings:
    base_url: str
    api_key: str | None
    workspace: str | None
    verify_tls: bool
    docling_endpoint: str | None
    docling_health_timeout_seconds: int
    readiness_timeout_seconds: int
    request_timeout_seconds: int
    query_concurrency: int
    max_top_k: int
    max_chunk_top_k: int
    max_total_tokens: int
    max_return_chars: int
    max_field_chars: int
    max_evidence_items: int
    max_upload_bytes: int
    ingest_roots: tuple[Path, ...]
    ingest_mode: IngestPathMode = "auto"
    ingest_container_dir: str = DEFAULT_INGEST_CONTAINER_DIR

    @classmethod
    def from_env(cls) -> "GatewaySettings":
        base_url = os.getenv("LIGHTRAG_BASE_URL", "http://127.0.0.1:9621").rstrip("/")
        parsed_url = urlparse(base_url)
        if parsed_url.scheme not in {"http", "https"} or not parsed_url.netloc:
            raise ValueError("LIGHTRAG_BASE_URL must be an http or https URL")

        return cls(
            base_url=base_url,
            api_key=os.getenv("LIGHTRAG_API_KEY") or None,
            workspace=os.getenv("LIGHTRAG_WORKSPACE") or None,
            verify_tls=_env_bool("LIGHTRAG_VERIFY_TLS", True),
            docling_endpoint=_optional_http_url("DOCLING_ENDPOINT"),
            docling_health_timeout_seconds=_env_int(
                "RAG_DOCLING_HEALTH_TIMEOUT_SECONDS", 10, 1, 120
            ),
            readiness_timeout_seconds=_env_int(
                "RAG_READINESS_TIMEOUT_SECONDS", 15, 1, 120
            ),
            request_timeout_seconds=_env_int(
                "RAG_REQUEST_TIMEOUT_SECONDS", 120, 1, 3600
            ),
            query_concurrency=_env_int("RAG_QUERY_CONCURRENCY", 4, 1, 64),
            max_top_k=_env_int("RAG_MAX_TOP_K", 20, 1, 200),
            max_chunk_top_k=_env_int("RAG_MAX_CHUNK_TOP_K", 20, 1, 200),
            max_total_tokens=_env_int(
                "RAG_MAX_TOTAL_TOKENS", 12000, 256, 200000
            ),
            max_return_chars=_env_int(
                "RAG_MAX_RETURN_CHARS", 30000, 1000, 1000000
            ),
            max_field_chars=_env_int("RAG_MAX_FIELD_CHARS", 6000, 100, 100000),
            max_evidence_items=_env_int(
                "RAG_MAX_EVIDENCE_ITEMS", 20, 1, 1000
            ),
            max_upload_bytes=_env_int(
                "RAG_MAX_UPLOAD_BYTES", 100 * 1024 * 1024, 1, 10 * 1024**3
            ),
            ingest_roots=_parse_allowed_roots(os.getenv("RAG_INGEST_ROOTS", "")),
            ingest_mode=_parse_ingest_mode(os.getenv("RAG_INGEST_MODE")),
            ingest_container_dir=(
                os.getenv(
                    "RAG_INGEST_GATEWAY_DIR",
                    os.getenv("RAG_INGEST_CONTAINER_DIR", DEFAULT_INGEST_CONTAINER_DIR),
                ).strip()
                or DEFAULT_INGEST_CONTAINER_DIR
            ),
        )


class LightRAGClient:
    def __init__(self, settings: GatewaySettings) -> None:
        self.settings = settings
        headers = {"Accept": "application/json"}
        if settings.api_key:
            headers["X-API-Key"] = settings.api_key
        if settings.workspace:
            headers["LIGHTRAG-WORKSPACE"] = settings.workspace

        self._client = httpx.AsyncClient(
            base_url=settings.base_url,
            headers=headers,
            timeout=httpx.Timeout(settings.request_timeout_seconds),
            verify=settings.verify_tls,
            follow_redirects=False,
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        started_at = time.perf_counter()
        request_headers = _request_headers(kwargs.pop("headers", None))
        try:
            response = await self._client.request(
                method,
                path,
                headers=request_headers or None,
                **kwargs,
            )
            response.raise_for_status()
            payload = response.json()
        except httpx.HTTPStatusError as exc:
            log_event(
                logger,
                "lightrag_request_failed",
                method=method,
                path=path,
                status_code=exc.response.status_code,
                duration_ms=round(elapsed_ms(started_at), 3),
                error_type=exc.__class__.__name__,
            )
            detail = self._error_detail(exc.response)
            raise LightRAGError(
                f"LightRAG returned HTTP {exc.response.status_code}: {detail}"
            ) from exc
        except httpx.RequestError as exc:
            log_event(
                logger,
                "lightrag_request_failed",
                method=method,
                path=path,
                duration_ms=round(elapsed_ms(started_at), 3),
                error_type=exc.__class__.__name__,
            )
            raise LightRAGError(f"Cannot reach LightRAG: {exc.__class__.__name__}") from exc
        except ValueError as exc:
            log_event(
                logger,
                "lightrag_request_failed",
                method=method,
                path=path,
                duration_ms=round(elapsed_ms(started_at), 3),
                error_type=exc.__class__.__name__,
            )
            raise LightRAGError("LightRAG returned invalid JSON") from exc

        if not isinstance(payload, dict):
            log_event(
                logger,
                "lightrag_request_failed",
                method=method,
                path=path,
                status_code=response.status_code,
                duration_ms=round(elapsed_ms(started_at), 3),
                error_type="InvalidResponsePayload",
            )
            raise LightRAGError("LightRAG returned a non-object JSON response")
        log_event(
            logger,
            "lightrag_request_completed",
            method=method,
            path=path,
            status_code=response.status_code,
            duration_ms=round(elapsed_ms(started_at), 3),
        )
        return payload

    async def upload(
        self,
        file_path: Path,
        processing_profile: ProcessingProfile = "text",
        upload_name: str | None = None,
    ) -> dict[str, Any]:
        encoded_name = processing_profile_filename(
            file_path, processing_profile, upload_name
        )
        try:
            with file_path.open("rb") as source:
                return await self.request(
                    "POST",
                    "/documents/upload",
                    files={"file": (encoded_name, source, "application/octet-stream")},
                )
        except OSError as exc:
            raise LightRAGError(f"Cannot read ingest file: {exc}") from exc

    async def track_status(self, track_id: str) -> dict[str, Any]:
        return await self.request(
            "GET", f"/documents/track_status/{encode_track_id(track_id)}"
        )

    async def find_track_id_by_filename(self, file_name: str) -> str | None:
        normalized_name = file_name.strip()
        if not normalized_name or Path(normalized_name).name != normalized_name:
            raise LightRAGError("file_name must be a file name without path components")

        page = 1
        while True:
            payload = await self.request(
                "POST",
                "/documents/paginated",
                json={
                    "status_filters": None,
                    "page": page,
                    "page_size": 200,
                    "sort_field": "updated_at",
                    "sort_direction": "desc",
                },
            )
            documents = payload.get("documents")
            if not isinstance(documents, list):
                raise LightRAGError("LightRAG paginated documents response is invalid")
            for document in documents:
                if not isinstance(document, dict):
                    continue
                if document.get("file_path") != normalized_name:
                    continue
                track_id = document.get("track_id")
                if isinstance(track_id, str) and track_id.strip():
                    return track_id.strip()

            pagination = payload.get("pagination")
            if not isinstance(pagination, dict) or not pagination.get("has_next"):
                return None
            page += 1

    async def delete_documents(
        self,
        document_ids: list[str],
        *,
        delete_files: bool,
        delete_llm_cache: bool,
    ) -> dict[str, Any]:
        normalized_ids = [item.strip() for item in document_ids if item.strip()]
        if not normalized_ids:
            raise LightRAGError("document_ids cannot be empty")
        if len(normalized_ids) != len(set(normalized_ids)):
            raise LightRAGError("document_ids must be unique")
        return await self.request(
            "DELETE",
            "/documents/delete_document",
            json={
                "doc_ids": normalized_ids,
                "delete_file": delete_files,
                "delete_llm_cache": delete_llm_cache,
            },
        )

    async def cancel_pipeline(self) -> dict[str, Any]:
        return await self.request("POST", "/documents/cancel_pipeline")

    def resolve_ingest_file(self, raw_path: str) -> Path:
        if not self.settings.ingest_roots:
            raise LightRAGError(
                "File ingestion is disabled until RAG_INGEST_ROOTS is configured"
            )

        file_path = Path(raw_path).expanduser().resolve()
        if self.settings.ingest_mode == "auto":
            relative = _container_relative_path(
                raw_path, self.settings.ingest_container_dir
            )
            if relative is not None:
                candidates = [
                    (root / relative).resolve()
                    for root in self.settings.ingest_roots
                ]
                valid_candidates = {
                    candidate
                    for candidate, root in zip(candidates, self.settings.ingest_roots)
                    if candidate.is_file() and candidate.is_relative_to(root)
                }
                if len(valid_candidates) > 1:
                    raise LightRAGError(
                        "Ingest path is ambiguous across RAG_INGEST_ROOTS"
                    )
                if valid_candidates:
                    file_path = next(iter(valid_candidates))
        if not file_path.is_file():
            raise LightRAGError(f"Ingest path is not a file: {file_path}")
        if not any(file_path.is_relative_to(root) for root in self.settings.ingest_roots):
            raise LightRAGError("Ingest path is outside RAG_INGEST_ROOTS")

        if file_path.stat().st_size > self.settings.max_upload_bytes:
            raise LightRAGError(
                f"Ingest file exceeds the {self.settings.max_upload_bytes} byte limit"
            )
        return file_path

    def bounded_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        bounded = self._limit_value(copy.deepcopy(payload))
        while self._json_size(bounded) > self.settings.max_return_chars:
            lists = self._collect_nonempty_lists(bounded)
            if not lists:
                return {
                    "status": payload.get("status", "truncated"),
                    "message": "LightRAG response exceeded the Gateway return limit",
                    "truncated": True,
                }
            max(lists, key=self._json_size).pop()
        return bounded

    def _limit_value(self, value: Any) -> Any:
        if isinstance(value, str):
            if len(value) <= self.settings.max_field_chars:
                return value
            return value[: self.settings.max_field_chars] + "... [truncated]"
        if isinstance(value, list):
            return [
                self._limit_value(item)
                for item in value[: self.settings.max_evidence_items]
            ]
        if isinstance(value, dict):
            return {key: self._limit_value(item) for key, item in value.items()}
        return value

    @classmethod
    def _collect_nonempty_lists(cls, value: Any) -> list[list[Any]]:
        found = []
        if isinstance(value, list):
            if value:
                found.append(value)
            for item in value:
                found.extend(cls._collect_nonempty_lists(item))
        elif isinstance(value, dict):
            for item in value.values():
                found.extend(cls._collect_nonempty_lists(item))
        return found

    @staticmethod
    def _json_size(value: Any) -> int:
        return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")))

    @staticmethod
    def _error_detail(response: httpx.Response) -> str:
        try:
            payload = response.json()
            if isinstance(payload, dict):
                detail = payload.get("detail") or payload.get("message") or payload
            else:
                detail = payload
        except ValueError:
            detail = response.text or response.reason_phrase
        return str(detail)[:500]


async def probe_docling_service(
    settings: GatewaySettings,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    if not settings.docling_endpoint:
        return {
            "configured": False,
            "reachable": False,
            "error": "DOCLING_ENDPOINT is not configured",
        }

    try:
        request_headers = _request_headers()
        async with httpx.AsyncClient(
            base_url=settings.docling_endpoint,
            headers=request_headers or None,
            timeout=httpx.Timeout(settings.docling_health_timeout_seconds),
            verify=settings.verify_tls,
            follow_redirects=False,
            transport=transport,
        ) as probe_client:
            response = await probe_client.get("/openapi.json")
            response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        return {
            "configured": True,
            "reachable": False,
            "error": f"HTTP {exc.response.status_code}",
        }
    except httpx.RequestError as exc:
        return {
            "configured": True,
            "reachable": False,
            "error": exc.__class__.__name__,
        }

    return {"configured": True, "reachable": True}


def encode_track_id(track_id: str) -> str:
    normalized = track_id.strip()
    if not normalized:
        raise LightRAGError("track_id cannot be empty")
    return quote(normalized, safe="")


def _request_headers(headers: dict[str, str] | None = None) -> dict[str, str]:
    resolved = dict(headers or {})
    request_id = get_request_id()
    if request_id and not any(name.lower() == "x-request-id" for name in resolved):
        resolved["X-Request-ID"] = request_id
    return resolved
