from __future__ import annotations

import asyncio
from collections import defaultdict
from difflib import SequenceMatcher
import hashlib
import json
import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Sequence
from urllib.parse import unquote, urlparse
from urllib.request import url2pathname
from uuid import UUID, uuid4, uuid5
from xml.etree import ElementTree

import asyncpg

from parent_child_chunks import (
    ParentChildChunk,
    build_parent_child_chunks_from_sidecar,
)
from rag_database import PostgresSettings, create_postgres_pool
from rag_observability import get_request_id, normalize_request_id


ProcessingProfile = Literal["text", "visual", "table", "full"]
RegistrationDisposition = Literal["registered", "idempotent"]
_ARTIFACT_COMPONENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
_WORKSPACE_COMPONENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
_GRAPH_FIELD_SEPARATOR = "<SEP>"


class RagRegistryRetryableError(RuntimeError):
    """The LightRAG-owned source is not readable at the current worker attempt."""


@dataclass(frozen=True)
class ParserIsolation:
    production_workspace: str
    production_artifact_namespace: str

    @classmethod
    def from_env(cls) -> "ParserIsolation":
        return cls(
            production_workspace=_required_env_or_default(
                "RAG_PRODUCTION_WORKSPACE", "default"
            ),
            production_artifact_namespace=_required_env_or_default(
                "RAG_PRODUCTION_ARTIFACT_NAMESPACE", "production"
            ),
        )

    def validate(self, parser_name: str, workspace: str, artifact_namespace: str) -> None:
        if parser_name == "mineru" and (
            workspace == self.production_workspace
            or artifact_namespace == self.production_artifact_namespace
        ):
            raise ValueError(
                "MinerU must use a workspace and artifact namespace isolated from "
                "production Docling"
            )


@dataclass(frozen=True)
class ArtifactStore:
    root: Path

    @classmethod
    def from_env(cls) -> "ArtifactStore":
        raw_root = os.getenv("RAG_ARTIFACT_ROOT", "./rag_artifacts").strip()
        if not raw_root:
            raise ValueError("RAG_ARTIFACT_ROOT must be configured")
        return cls(Path(raw_root).expanduser().resolve())

    def revision_dir(
        self, artifact_namespace: str, document_id: UUID, revision: int
    ) -> Path:
        _validate_artifact_namespace(artifact_namespace)
        if revision < 1:
            raise ValueError("revision must be at least 1")
        return self.root / artifact_namespace / str(document_id) / f"r{revision}"

    def source_path(
        self,
        artifact_namespace: str,
        document_id: UUID,
        revision: int,
        source_name: str,
    ) -> Path:
        return self.revision_dir(artifact_namespace, document_id, revision) / "source" / Path(
            source_name
        ).name

    def parser_output_dir(
        self,
        artifact_namespace: str,
        document_id: UUID,
        revision: int,
        parser_run_id: UUID,
    ) -> Path:
        return (
            self.revision_dir(artifact_namespace, document_id, revision)
            / "parsed"
            / str(parser_run_id)
        )

    def page_routing_manifest_path(
        self, artifact_namespace: str, document_id: UUID, revision: int
    ) -> Path:
        return (
            self.revision_dir(artifact_namespace, document_id, revision)
            / "page-routing"
            / "manifest.json"
        )

    def remove_revision_dir(
        self, artifact_namespace: str, document_id: UUID, revision: int
    ) -> None:
        target = self.revision_dir(artifact_namespace, document_id, revision).resolve()
        root = self.root.resolve()
        if not target.is_relative_to(root):
            raise ValueError("Artifact deletion target escapes RAG_ARTIFACT_ROOT")
        if target.exists():
            shutil.rmtree(target)


@dataclass(frozen=True)
class IngestRequest:
    source_path: Path
    source_key: str
    parser_name: str = "docling"
    parser_version: str | None = None
    workspace: str = "default"
    artifact_namespace: str = "production"
    processing_profile: ProcessingProfile = "text"
    force_new_revision: bool = False
    request_id: str | None = None


@dataclass(frozen=True)
class IngestRegistration:
    disposition: RegistrationDisposition
    document_id: UUID
    revision: int
    content_sha256: str
    source_uri: str
    artifact_namespace: str
    parser_run_id: UUID | None
    task_id: UUID | None


@dataclass(frozen=True)
class ArtifactLocation:
    artifact_namespace: str
    revision: int


@dataclass(frozen=True)
class DeletionManifest:
    document_id: UUID
    lightrag_document_ids: tuple[str, ...]
    artifact_locations: tuple[ArtifactLocation, ...]


@dataclass(frozen=True)
class ParserArtifact:
    relative_path: str
    artifact_uri: str
    artifact_kind: str
    content_sha256: str
    byte_size: int


@dataclass(frozen=True)
class ParserCaptureSummary:
    artifact_count: int
    parent_chunks: int
    child_chunks: int


@dataclass(frozen=True)
class ChunkLinkSummary:
    lightrag_chunks: int
    link_count: int
    primary_link_count: int


@dataclass(frozen=True)
class GraphFactSummary:
    relation_count: int
    fact_count: int


GraphFactRow = tuple[
    UUID,
    UUID,
    int,
    str,
    str,
    str,
    str,
    UUID,
    str,
    str,
    str,
    str,
]


@dataclass(frozen=True)
class _GraphEdge:
    source: str
    target: str
    attributes: dict[str, str]


class RagRegistry:
    """Persistent registry for source revisions and parser-derived retrieval metadata."""

    def __init__(
        self,
        pool: asyncpg.Pool,
        artifact_store: ArtifactStore,
        parser_isolation: ParserIsolation,
    ) -> None:
        self._pool = pool
        self._artifact_store = artifact_store
        self._parser_isolation = parser_isolation

    @classmethod
    async def connect_from_env(cls) -> "RagRegistry":
        pool = await create_postgres_pool(PostgresSettings.from_env())
        return cls(pool, ArtifactStore.from_env(), ParserIsolation.from_env())

    async def close(self) -> None:
        await self._pool.close()

    @property
    def pool(self) -> asyncpg.Pool:
        return self._pool

    async def register_ingest(self, request: IngestRequest) -> IngestRegistration:
        (
            source_path,
            source_key,
            parser_name,
            workspace,
            artifact_namespace,
        ) = self._validate_request(request)
        request_id = normalize_request_id(request.request_id)
        registry_source_key = _scoped_source_key(
            source_key, parser_name, workspace, artifact_namespace
        )
        content_sha256 = await asyncio.to_thread(_sha256_file, source_path)

        async with self._pool.acquire() as connection:
            async with connection.transaction():
                await connection.execute(
                    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
                    registry_source_key,
                )
                document = await connection.fetchrow(
                    """
                    SELECT document_id, current_revision, deleted_at, delete_requested_at
                    FROM rag.documents
                    WHERE source_key = $1
                    FOR UPDATE
                    """,
                    registry_source_key,
                )

                if document is None:
                    document_id = uuid4()
                    revision = 1
                    await connection.execute(
                        """
                        INSERT INTO rag.documents (document_id, source_key, current_revision)
                        VALUES ($1, $2, $3)
                        """,
                        document_id,
                        registry_source_key,
                        revision,
                    )
                else:
                    document_id = document["document_id"]
                    if (
                        document["deleted_at"] is None
                        and document["delete_requested_at"] is not None
                    ):
                        raise ValueError("Document deletion is pending")
                    current_revision = document["current_revision"]
                    current = await connection.fetchrow(
                        """
                        SELECT revision, content_sha256, source_uri
                        FROM rag.document_revisions
                        WHERE document_id = $1 AND revision = $2
                        """,
                        document_id,
                        current_revision,
                    )
                    if (
                        current is not None
                        and current["content_sha256"] == content_sha256
                        and not request.force_new_revision
                    ):
                        existing_run = await connection.fetchrow(
                            """
                            SELECT parser_run_id
                            FROM rag.parser_runs
                            WHERE document_id = $1
                              AND revision = $2
                              AND parser_name = $3
                              AND workspace = $4
                            """,
                            document_id,
                            current_revision,
                            parser_name,
                            workspace,
                        )
                        existing_task = await connection.fetchrow(
                            """
                            SELECT task_id
                            FROM rag.ingest_tasks
                            WHERE document_id = $1
                              AND revision = $2
                              AND task_type IN ('ingest', 'rebuild')
                            ORDER BY requested_at DESC
                            LIMIT 1
                            """,
                            document_id,
                            current_revision,
                        )
                        return IngestRegistration(
                            disposition="idempotent",
                            document_id=document_id,
                            revision=current_revision,
                            content_sha256=content_sha256,
                            source_uri=current["source_uri"],
                            artifact_namespace=artifact_namespace,
                            parser_run_id=(
                                existing_run["parser_run_id"]
                                if existing_run is not None
                                else None
                            ),
                            task_id=(
                                existing_task["task_id"]
                                if existing_task is not None
                                else None
                            ),
                        )

                    revision = current_revision + 1
                    await connection.execute(
                        """
                        UPDATE rag.documents
                        SET current_revision = $2, updated_at = now(), deleted_at = NULL,
                            delete_requested_at = NULL
                        WHERE document_id = $1
                        """,
                        document_id,
                        revision,
                    )

                source_target = self._artifact_store.source_path(
                    artifact_namespace, document_id, revision, source_path.name
                )
                parser_run_id = uuid4()
                task_id = uuid4()
                source_uri = source_target.as_uri()
                task_type = "rebuild" if request.force_new_revision else "ingest"
                task_payload = json.dumps(
                    {
                        "source_uri": source_uri,
                        "processing_profile": request.processing_profile,
                        "workspace": workspace,
                        "artifact_namespace": artifact_namespace,
                        "lightrag_upload_name": (
                            f"{document_id}-r{revision}{source_path.suffix}"
                        ),
                    }
                )
                await connection.execute(
                    """
                    INSERT INTO rag.document_revisions (
                        document_id, revision, content_sha256, source_uri, parser_name,
                        parser_version, processing_profile
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                    """,
                    document_id,
                    revision,
                    content_sha256,
                    source_uri,
                    parser_name,
                    request.parser_version,
                    request.processing_profile,
                )
                await connection.execute(
                    """
                    INSERT INTO rag.parser_runs (
                        parser_run_id, document_id, revision, parser_name, parser_version,
                        workspace, artifact_namespace, status
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued')
                    """,
                    parser_run_id,
                    document_id,
                    revision,
                    parser_name,
                    request.parser_version,
                    workspace,
                    artifact_namespace,
                )
                await connection.execute(
                    """
                    INSERT INTO rag.ingest_tasks (
                        task_id, document_id, revision, task_type, status, payload,
                        next_attempt_at, request_id
                    )
                    VALUES ($1, $2, $3, $4, 'queued', $5::jsonb, now(), $6)
                    """,
                    task_id,
                    document_id,
                    revision,
                    task_type,
                    task_payload,
                    request_id,
                )
                await connection.execute(
                    """
                    INSERT INTO rag.ingest_task_events (
                        task_id, from_status, to_status, detail, request_id
                    )
                    VALUES ($1, NULL, 'queued', 'ingest requested', $2)
                    """,
                    task_id,
                    request_id,
                )

        registration = IngestRegistration(
            disposition="registered",
            document_id=document_id,
            revision=revision,
            content_sha256=content_sha256,
            source_uri=source_uri,
            artifact_namespace=artifact_namespace,
            parser_run_id=parser_run_id,
            task_id=task_id,
        )
        try:
            await asyncio.to_thread(_copy_file_once, source_path, source_target)
        except OSError as exc:
            await self._mark_registration_failed(registration, str(exc))
            raise RuntimeError(f"Unable to persist source artifact: {exc}") from exc
        return registration

    async def capture_docling_output(
        self, registration: IngestRegistration, sidecar_dir: Path
    ) -> list[ParentChildChunk]:
        if registration.disposition != "registered" or registration.parser_run_id is None:
            raise ValueError("Only a newly registered revision can capture parser output")

        source_sidecar = sidecar_dir.expanduser().resolve()
        if not source_sidecar.is_dir():
            raise RagRegistryRetryableError(
                "LightRAG sidecar directory is not available to the worker"
            )

        destination = self._artifact_store.parser_output_dir(
            registration.artifact_namespace,
            registration.document_id,
            registration.revision,
            registration.parser_run_id,
        )
        try:
            await self._mark_parser_running(registration.parser_run_id)
            await asyncio.to_thread(
                _copy_directory_idempotent, source_sidecar, destination
            )
            blocks_path = await asyncio.to_thread(_discover_blocks_jsonl, destination)
            chunks = await asyncio.to_thread(
                build_parent_child_chunks_from_sidecar,
                blocks_path,
                document_id=registration.document_id,
                revision=registration.revision,
                source_uri=registration.source_uri,
            )
            artifacts = await asyncio.to_thread(_artifact_inventory, destination)
            await self._replace_chunks_and_complete_parser(
                registration, destination.as_uri(), chunks, artifacts
            )
            return chunks
        except RagRegistryRetryableError:
            raise
        except (OSError, ValueError) as exc:
            await self._mark_registration_failed(registration, str(exc))
            raise RuntimeError(f"Unable to persist Docling parser output: {exc}") from exc

    async def capture_lightrag_output(
        self,
        document_id: UUID,
        revision: int,
        workspace: str,
        lightrag_document_id: str,
        sidecar_root: Path,
    ) -> ParserCaptureSummary:
        """Copy the completed LightRAG sidecar before the revision is searchable."""

        normalized_workspace = _normalize_workspace(workspace)
        normalized_document_id = _normalize_lightrag_document_id(lightrag_document_id)
        registration = await self._registration_for_parser_output(
            document_id, revision, normalized_workspace
        )
        sidecar_uri = await self._lightrag_sidecar_location(
            normalized_workspace, normalized_document_id
        )
        sidecar_dir = _resolve_lightrag_sidecar_dir(sidecar_uri, sidecar_root)
        chunks = await self.capture_docling_output(registration, sidecar_dir)
        return ParserCaptureSummary(
            artifact_count=len(await self._parser_artifacts(registration.parser_run_id)),
            parent_chunks=sum(chunk.chunk_kind == "parent" for chunk in chunks),
            child_chunks=sum(chunk.chunk_kind == "child" for chunk in chunks),
        )

    async def synchronize_lightrag_chunk_links(
        self,
        document_id: UUID,
        revision: int,
        workspace: str,
        lightrag_document_id: str,
    ) -> ChunkLinkSummary:
        """Bind every LightRAG vector chunk to its sidecar-backed child chunks."""

        normalized_workspace = _normalize_workspace(workspace)
        normalized_document_id = _normalize_lightrag_document_id(lightrag_document_id)
        parser_run = await self._parser_run_for_workspace(
            document_id, revision, normalized_workspace
        )
        parser_dir = self._artifact_store.parser_output_dir(
            parser_run["artifact_namespace"],
            document_id,
            revision,
            parser_run["parser_run_id"],
        )
        if not parser_dir.is_dir():
            raise RagRegistryRetryableError("Persisted parser artifacts are unavailable")

        modality_block_ids = await asyncio.to_thread(
            _sidecar_modality_block_ids, parser_dir
        )
        async with self._pool.acquire() as connection:
            lightrag_rows = await connection.fetch(
                """
                SELECT id, content, sidecar
                FROM lightrag_doc_chunks
                WHERE workspace = $1 AND full_doc_id = $2
                ORDER BY chunk_order_index, id
                """,
                normalized_workspace,
                normalized_document_id,
            )
            child_rows = await connection.fetch(
                """
                SELECT chunk_id, ordinal, content, source_block_id
                FROM rag.chunks
                WHERE document_id = $1 AND revision = $2 AND chunk_kind = 'child'
                ORDER BY ordinal, chunk_id
                """,
                document_id,
                revision,
            )

        if not lightrag_rows:
            if child_rows:
                raise RagRegistryRetryableError("LightRAG text chunks are not available")
            async with self._pool.acquire() as connection:
                await connection.execute(
                    """
                    DELETE FROM rag.lightrag_chunk_links
                    WHERE document_id = $1 AND revision = $2
                    """,
                    document_id,
                    revision,
                )
            return ChunkLinkSummary(
                lightrag_chunks=0, link_count=0, primary_link_count=0
            )
        if not child_rows:
            raise RagRegistryRetryableError("Parent/child chunks are not available")

        children_by_block: dict[str, list[asyncpg.Record]] = defaultdict(list)
        for child in child_rows:
            block_id = child["source_block_id"]
            if isinstance(block_id, str) and block_id:
                children_by_block[block_id].append(child)

        links: list[tuple[UUID, int, str, str, UUID, int, bool, str]] = []
        unresolved_ids: list[str] = []
        for lightrag_row in lightrag_rows:
            lightrag_chunk_id = _normalize_lightrag_document_id(lightrag_row["id"])
            sidecar = _json_object(lightrag_row["sidecar"])
            block_ids, mapping_kind, has_unresolved_refs = _sidecar_block_ids(
                sidecar, modality_block_ids
            )
            candidates: dict[UUID, asyncpg.Record] = {}
            for block_id in block_ids:
                for child in children_by_block.get(block_id, []):
                    candidates[child["chunk_id"]] = child
            if has_unresolved_refs or not candidates:
                unresolved_ids.append(lightrag_chunk_id)
                continue

            lightrag_content = _optional_text(lightrag_row["content"]) or ""
            ordered_candidates = sorted(
                candidates.values(),
                key=lambda child: (
                    -_content_overlap_score(lightrag_content, child["content"]),
                    child["ordinal"],
                    str(child["chunk_id"]),
                ),
            )
            for ordinal, child in enumerate(ordered_candidates):
                links.append(
                    (
                        document_id,
                        revision,
                        normalized_workspace,
                        lightrag_chunk_id,
                        child["chunk_id"],
                        ordinal,
                        ordinal == 0,
                        mapping_kind,
                    )
                )

        if unresolved_ids:
            sample = ", ".join(unresolved_ids[:5])
            raise RagRegistryRetryableError(
                "LightRAG chunks are missing sidecar-backed child provenance: "
                f"{sample}"
            )

        async with self._pool.acquire() as connection:
            async with connection.transaction():
                await connection.execute(
                    """
                    DELETE FROM rag.lightrag_chunk_links
                    WHERE document_id = $1 AND revision = $2
                    """,
                    document_id,
                    revision,
                )
                await connection.executemany(
                    """
                    INSERT INTO rag.lightrag_chunk_links (
                        document_id, revision, workspace, lightrag_chunk_id, chunk_id,
                        link_ordinal, is_primary, mapping_kind
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    """,
                    links,
                )

        return ChunkLinkSummary(
            lightrag_chunks=len(lightrag_rows),
            link_count=len(links),
            primary_link_count=len(lightrag_rows),
        )

    async def synchronize_graph_facts(
        self,
        document_id: UUID,
        revision: int,
        workspace: str,
        graph_working_dir: Path,
    ) -> GraphFactSummary:
        """Write revision-scoped graph facts only after source chunk links exist."""

        normalized_workspace = _normalize_workspace(workspace)
        async with self._pool.acquire() as connection:
            link_rows = await connection.fetch(
                """
                SELECT lightrag_chunk_id, chunk_id
                FROM rag.lightrag_chunk_links
                WHERE document_id = $1 AND revision = $2 AND workspace = $3
                ORDER BY lightrag_chunk_id, link_ordinal, chunk_id
                """,
                document_id,
                revision,
                normalized_workspace,
            )

        chunks_by_lightrag_id: dict[str, list[UUID]] = defaultdict(list)
        for link in link_rows:
            chunks_by_lightrag_id[link["lightrag_chunk_id"]].append(link["chunk_id"])
        if not chunks_by_lightrag_id:
            raise RagRegistryRetryableError("Graph facts require completed vector provenance")

        async with self._pool.acquire() as connection:
            relation_rows = await connection.fetch(
                """
                SELECT id, chunk_ids
                FROM lightrag_relation_chunks
                WHERE workspace = $1 AND chunk_ids ?| $2::text[]
                ORDER BY id
                """,
                normalized_workspace,
                sorted(chunks_by_lightrag_id),
            )

        relevant_relations: dict[str, list[str]] = {}
        for relation in relation_rows:
            raw_relation_id = _optional_text(relation["id"])
            if not raw_relation_id:
                raise ValueError("LightRAG relation chunk row is missing id")
            relation_id = _normalize_relation_key(raw_relation_id)
            source_ids = [
                source_id
                for source_id in _json_text_list(relation["chunk_ids"])
                if source_id in chunks_by_lightrag_id
            ]
            if source_ids:
                existing_source_ids = relevant_relations.setdefault(relation_id, [])
                existing_source_ids.extend(
                    source_id
                    for source_id in source_ids
                    if source_id not in existing_source_ids
                )

        if not relevant_relations:
            await self._replace_graph_facts(document_id, revision, [])
            return GraphFactSummary(relation_count=0, fact_count=0)

        graph_path = _graphml_path(graph_working_dir, normalized_workspace)
        graph_edges = await asyncio.to_thread(_load_graph_edges, graph_path)
        missing_edges = sorted(set(relevant_relations).difference(graph_edges))
        if missing_edges:
            raise RagRegistryRetryableError(
                "LightRAG graph has not committed relation edges: "
                + ", ".join(missing_edges[:5])
            )

        facts: list[GraphFactRow] = []
        for relation_id, source_ids in relevant_relations.items():
            edge = graph_edges[relation_id]
            keywords = _optional_text(edge.attributes.get("keywords"))
            description = _optional_text(edge.attributes.get("description"))
            predicate = keywords or "related_to"
            for lightrag_chunk_id in source_ids:
                for evidence_chunk_id in chunks_by_lightrag_id[lightrag_chunk_id]:
                    identity = {
                        "edge_key": relation_id,
                        "evidence_chunk_id": str(evidence_chunk_id),
                        "lightrag_chunk_id": lightrag_chunk_id,
                        "revision": revision,
                        "workspace": normalized_workspace,
                    }
                    fact_sha256 = _sha256_text(
                        json.dumps(identity, ensure_ascii=False, sort_keys=True)
                    )
                    attributes = {
                        "description": description,
                        "directionality": "undirected_networkx",
                        "file_path": _optional_text(edge.attributes.get("file_path")),
                        "keywords": keywords,
                        "weight": _optional_text(edge.attributes.get("weight")),
                    }
                    facts.append(
                        (
                            uuid5(document_id, f"revision={revision}:graph:{fact_sha256}"),
                            document_id,
                            revision,
                            fact_sha256,
                            edge.source,
                            predicate,
                            edge.target,
                            evidence_chunk_id,
                            json.dumps(attributes, ensure_ascii=False),
                            lightrag_chunk_id,
                            normalized_workspace,
                            relation_id,
                        )
                    )

        await self._replace_graph_facts(document_id, revision, facts)
        return GraphFactSummary(
            relation_count=len(relevant_relations), fact_count=len(facts)
        )

    async def record_lightrag_document(
        self, document_id: UUID, revision: int, lightrag_document_id: str
    ) -> None:
        normalized_id = lightrag_document_id.strip()
        if not normalized_id:
            raise ValueError("lightrag_document_id cannot be empty")
        async with self._pool.acquire() as connection:
            result = await connection.execute(
                """
                UPDATE rag.document_revisions
                SET lightrag_document_id = $3
                WHERE document_id = $1 AND revision = $2
                """,
                document_id,
                revision,
                normalized_id,
            )
        if result == "UPDATE 0":
            raise ValueError("Unknown document revision")

    async def list_documents(self, *, page: int = 1, page_size: int = 50) -> dict[str, Any]:
        """Return active registry documents with IDs safe for management writes."""
        page = max(1, page)
        page_size = min(max(10, page_size), 200)
        offset = (page - 1) * page_size
        async with self._pool.acquire() as connection:
            total = await connection.fetchval(
                "SELECT count(*) FROM rag.documents WHERE deleted_at IS NULL"
            )
            rows = await connection.fetch(
                """
                SELECT
                    document.document_id,
                    document.current_revision,
                    document.source_key,
                    document.created_at,
                    document.updated_at,
                    document.delete_requested_at,
                    revision.source_uri,
                    revision.processing_profile,
                    revision.lightrag_document_id,
                    task.task_id AS latest_task_id,
                    task.status AS latest_task_status,
                    task.error_detail AS latest_task_error
                FROM rag.documents AS document
                LEFT JOIN rag.document_revisions AS revision
                  ON revision.document_id = document.document_id
                 AND revision.revision = document.current_revision
                LEFT JOIN LATERAL (
                    SELECT task_id, status, error_detail
                    FROM rag.ingest_tasks
                    WHERE document_id = document.document_id
                    ORDER BY requested_at DESC, task_id DESC
                    LIMIT 1
                ) AS task ON TRUE
                WHERE document.deleted_at IS NULL
                ORDER BY document.updated_at DESC, document.document_id
                LIMIT $1 OFFSET $2
                """,
                page_size,
                offset,
            )
        return {
            "documents": [
                {
                    "document_id": str(row["document_id"]),
                    "revision": row["current_revision"],
                    "source_key": row["source_key"],
                    "source_uri": row["source_uri"],
                    "processing_profile": row["processing_profile"],
                    "lightrag_document_id": row["lightrag_document_id"],
                    "created_at": row["created_at"].isoformat(),
                    "updated_at": row["updated_at"].isoformat(),
                    "delete_requested": row["delete_requested_at"] is not None,
                    "task_id": str(row["latest_task_id"]) if row["latest_task_id"] else None,
                    "status": row["latest_task_status"] or "registered",
                    "error_detail": row["latest_task_error"],
                }
                for row in rows
            ],
            "total": int(total or 0),
            "page": page,
            "page_size": page_size,
        }

    async def build_deletion_manifest(self, document_id: UUID) -> DeletionManifest:
        async with self._pool.acquire() as connection:
            rows = await connection.fetch(
                """
                SELECT revision, lightrag_document_id
                FROM rag.document_revisions
                WHERE document_id = $1
                ORDER BY revision
                """,
                document_id,
            )
            artifact_locations = await connection.fetch(
                """
                SELECT DISTINCT revision, artifact_namespace
                FROM rag.parser_runs
                WHERE document_id = $1
                ORDER BY revision, artifact_namespace
                """,
                document_id,
            )

        if not rows:
            raise ValueError("Unknown document or document has no retained revisions")
        return DeletionManifest(
            document_id=document_id,
            lightrag_document_ids=tuple(
                row["lightrag_document_id"]
                for row in rows
                if row["lightrag_document_id"]
            ),
            artifact_locations=tuple(
                ArtifactLocation(
                    artifact_namespace=row["artifact_namespace"], revision=row["revision"]
                )
                for row in artifact_locations
            ),
        )

    async def finalize_document_deletion(self, manifest: DeletionManifest) -> None:
        """Remove registry data after LightRAG deletion while retaining task audit rows."""

        async with self._pool.acquire() as connection:
            async with connection.transaction():
                exists = await connection.fetchval(
                    "SELECT EXISTS(SELECT 1 FROM rag.documents WHERE document_id = $1)",
                    manifest.document_id,
                )
                if not exists:
                    raise ValueError("Unknown document")
                await connection.execute(
                    """
                    DELETE FROM rag.document_revisions
                    WHERE document_id = $1
                    """,
                    manifest.document_id,
                )
                await connection.execute(
                    """
                    UPDATE rag.documents
                    SET deleted_at = now(), delete_requested_at = NULL, updated_at = now()
                    WHERE document_id = $1
                    """,
                    manifest.document_id,
                )

        for location in manifest.artifact_locations:
            await asyncio.to_thread(
                self._artifact_store.remove_revision_dir,
                location.artifact_namespace,
                manifest.document_id,
                location.revision,
            )

    def _validate_request(
        self, request: IngestRequest
    ) -> tuple[Path, str, str, str, str]:
        source_path = request.source_path.expanduser().resolve()
        if not source_path.is_file():
            raise ValueError(f"source_path is not a file: {source_path}")
        source_key = request.source_key.strip()
        if not source_key:
            raise ValueError("source_key cannot be empty")
        parser_name = request.parser_name.strip().lower()
        workspace = _normalize_workspace(request.workspace)
        artifact_namespace = request.artifact_namespace.strip()
        if not parser_name:
            raise ValueError("parser_name cannot be empty")
        if not workspace:
            raise ValueError("workspace cannot be empty")
        _validate_artifact_namespace(artifact_namespace)
        if request.processing_profile not in {"text", "visual", "table", "full"}:
            raise ValueError("processing_profile is invalid")
        self._parser_isolation.validate(parser_name, workspace, artifact_namespace)
        return source_path, source_key, parser_name, workspace, artifact_namespace

    async def _registration_for_parser_output(
        self, document_id: UUID, revision: int, workspace: str
    ) -> IngestRegistration:
        normalized_workspace = _normalize_workspace(workspace)
        async with self._pool.acquire() as connection:
            row = await connection.fetchrow(
                """
                SELECT
                    revision_row.content_sha256,
                    revision_row.source_uri,
                    parser_run.parser_run_id,
                    parser_run.artifact_namespace,
                    (
                        SELECT task.task_id
                        FROM rag.ingest_tasks AS task
                        WHERE task.document_id = revision_row.document_id
                          AND task.revision = revision_row.revision
                          AND task.task_type IN ('ingest', 'rebuild')
                        ORDER BY task.requested_at DESC, task.task_id DESC
                        LIMIT 1
                    ) AS task_id
                FROM rag.document_revisions AS revision_row
                JOIN rag.parser_runs AS parser_run
                  ON parser_run.document_id = revision_row.document_id
                 AND parser_run.revision = revision_row.revision
                 AND parser_run.parser_name = revision_row.parser_name
                WHERE revision_row.document_id = $1
                  AND revision_row.revision = $2
                  AND parser_run.workspace = $3
                ORDER BY parser_run.created_at DESC, parser_run.parser_run_id DESC
                LIMIT 1
                """,
                document_id,
                revision,
                normalized_workspace,
            )
        if row is None:
            raise ValueError("No parser run matches the LightRAG document revision")

        parser_run_id = row["parser_run_id"]
        content_sha256 = _optional_text(row["content_sha256"])
        source_uri = _optional_text(row["source_uri"])
        artifact_namespace = _optional_text(row["artifact_namespace"])
        if not isinstance(parser_run_id, UUID):
            raise ValueError("Parser run ID is invalid")
        if not content_sha256 or not source_uri or not artifact_namespace:
            raise ValueError("Parser run is missing required registration metadata")
        return IngestRegistration(
            disposition="registered",
            document_id=document_id,
            revision=revision,
            content_sha256=content_sha256,
            source_uri=source_uri,
            artifact_namespace=artifact_namespace,
            parser_run_id=parser_run_id,
            task_id=row["task_id"],
        )

    async def _lightrag_sidecar_location(
        self, workspace: str, lightrag_document_id: str
    ) -> str:
        async with self._pool.acquire() as connection:
            row = await connection.fetchrow(
                """
                SELECT sidecar_location
                FROM lightrag_doc_full
                WHERE workspace = $1 AND id = $2
                """,
                workspace,
                lightrag_document_id,
            )
        sidecar_uri = _optional_text(row["sidecar_location"]) if row else None
        if not sidecar_uri:
            raise RagRegistryRetryableError(
                "LightRAG sidecar location is not available for the document"
            )
        return sidecar_uri

    async def _parser_run_for_workspace(
        self, document_id: UUID, revision: int, workspace: str
    ) -> asyncpg.Record:
        normalized_workspace = _normalize_workspace(workspace)
        async with self._pool.acquire() as connection:
            row = await connection.fetchrow(
                """
                SELECT parser_run.parser_run_id, parser_run.artifact_namespace,
                       parser_run.status, parser_run.artifact_uri
                FROM rag.parser_runs AS parser_run
                JOIN rag.document_revisions AS revision_row
                  ON revision_row.document_id = parser_run.document_id
                 AND revision_row.revision = parser_run.revision
                 AND revision_row.parser_name = parser_run.parser_name
                WHERE parser_run.document_id = $1
                  AND parser_run.revision = $2
                  AND parser_run.workspace = $3
                ORDER BY parser_run.created_at DESC, parser_run.parser_run_id DESC
                LIMIT 1
                """,
                document_id,
                revision,
                normalized_workspace,
            )
        if row is None:
            raise ValueError("No parser run matches the LightRAG workspace")
        if row["status"] != "completed":
            raise RagRegistryRetryableError("Parser artifacts are not completed")
        if not isinstance(row["parser_run_id"], UUID):
            raise ValueError("Parser run ID is invalid")
        if not _optional_text(row["artifact_namespace"]):
            raise ValueError("Parser artifact namespace is invalid")
        return row

    async def _parser_artifacts(self, parser_run_id: UUID | None) -> list[ParserArtifact]:
        if parser_run_id is None:
            return []
        async with self._pool.acquire() as connection:
            rows = await connection.fetch(
                """
                SELECT relative_path, artifact_uri, artifact_kind, content_sha256, byte_size
                FROM rag.parser_artifacts
                WHERE parser_run_id = $1
                ORDER BY relative_path
                """,
                parser_run_id,
            )
        return [
            ParserArtifact(
                relative_path=row["relative_path"],
                artifact_uri=row["artifact_uri"],
                artifact_kind=row["artifact_kind"],
                content_sha256=row["content_sha256"],
                byte_size=row["byte_size"],
            )
            for row in rows
        ]

    async def _mark_parser_running(self, parser_run_id: UUID) -> None:
        async with self._pool.acquire() as connection:
            await connection.execute(
                """
                UPDATE rag.parser_runs
                SET status = 'running', started_at = COALESCE(started_at, now()),
                    error_detail = NULL
                WHERE parser_run_id = $1 AND status IN ('queued', 'failed')
                """,
                parser_run_id,
            )

    async def _mark_registration_failed(
        self, registration: IngestRegistration, detail: str
    ) -> None:
        error_detail = detail[:4000]
        async with self._pool.acquire() as connection:
            async with connection.transaction():
                if registration.parser_run_id is not None:
                    await connection.execute(
                        """
                        UPDATE rag.parser_runs
                        SET status = 'failed', error_detail = $2, finished_at = now()
                        WHERE parser_run_id = $1
                        """,
                        registration.parser_run_id,
                        error_detail,
                    )
                if registration.task_id is not None:
                    previous_status = await connection.fetchval(
                        """
                        SELECT status
                        FROM rag.ingest_tasks
                        WHERE task_id = $1
                        FOR UPDATE
                        """,
                        registration.task_id,
                    )
                    await connection.execute(
                        """
                        UPDATE rag.ingest_tasks
                        SET status = 'failed', error_detail = $2, finished_at = now(),
                            updated_at = now()
                        WHERE task_id = $1
                        """,
                        registration.task_id,
                        error_detail,
                    )
                    if previous_status is not None:
                        await connection.execute(
                            """
                            INSERT INTO rag.ingest_task_events (
                                task_id, from_status, to_status, detail, request_id
                            )
                            VALUES ($1, $2, 'failed', $3, $4)
                            """,
                            registration.task_id,
                            previous_status,
                            error_detail,
                            get_request_id(),
                        )

    async def _replace_chunks_and_complete_parser(
        self,
        registration: IngestRegistration,
        parsed_uri: str,
        chunks: Sequence[ParentChildChunk],
        artifacts: Sequence[ParserArtifact],
    ) -> None:
        async with self._pool.acquire() as connection:
            async with connection.transaction():
                await connection.execute(
                    "DELETE FROM rag.graph_facts WHERE document_id = $1 AND revision = $2",
                    registration.document_id,
                    registration.revision,
                )
                await connection.execute(
                    "DELETE FROM rag.chunks WHERE document_id = $1 AND revision = $2",
                    registration.document_id,
                    registration.revision,
                )
                await connection.execute(
                    "DELETE FROM rag.parser_artifacts WHERE parser_run_id = $1",
                    registration.parser_run_id,
                )
                if chunks:
                    await connection.executemany(
                        """
                        INSERT INTO rag.chunks (
                            chunk_id, document_id, revision, ordinal, content_sha256,
                            token_count, metadata, chunk_kind, parent_chunk_id, content,
                            source_page, source_block_id, source_uri
                        )
                        VALUES (
                            $1, $2, $3, $4, $5, NULL, $6::jsonb, $7, $8, $9,
                            $10, $11, $12
                        )
                        """,
                        [
                            (
                                chunk.chunk_id,
                                chunk.document_id,
                                chunk.revision,
                                chunk.ordinal,
                                chunk.content_sha256,
                                json.dumps(chunk.metadata, ensure_ascii=False),
                                chunk.chunk_kind,
                                chunk.parent_chunk_id,
                                chunk.content,
                                chunk.source_page,
                                chunk.source_block_id,
                                chunk.source_uri,
                            )
                            for chunk in chunks
                        ],
                    )
                if artifacts:
                    await connection.executemany(
                        """
                        INSERT INTO rag.parser_artifacts (
                            parser_run_id, relative_path, artifact_uri, artifact_kind,
                            content_sha256, byte_size
                        )
                        VALUES ($1, $2, $3, $4, $5, $6)
                        """,
                        [
                            (
                                registration.parser_run_id,
                                artifact.relative_path,
                                artifact.artifact_uri,
                                artifact.artifact_kind,
                                artifact.content_sha256,
                                artifact.byte_size,
                            )
                            for artifact in artifacts
                        ],
                    )
                await connection.execute(
                    """
                    UPDATE rag.document_revisions
                    SET parsed_uri = $3
                    WHERE document_id = $1 AND revision = $2
                    """,
                    registration.document_id,
                    registration.revision,
                    parsed_uri,
                )
                await connection.execute(
                    """
                    UPDATE rag.parser_runs
                    SET status = 'completed', artifact_uri = $2, finished_at = now(),
                        error_detail = NULL
                    WHERE parser_run_id = $1
                    """,
                    registration.parser_run_id,
                    parsed_uri,
                )

    async def _replace_graph_facts(
        self, document_id: UUID, revision: int, facts: Sequence[GraphFactRow]
    ) -> None:
        async with self._pool.acquire() as connection:
            async with connection.transaction():
                await connection.execute(
                    "DELETE FROM rag.graph_facts WHERE document_id = $1 AND revision = $2",
                    document_id,
                    revision,
                )
                if facts:
                    await connection.executemany(
                        """
                        INSERT INTO rag.graph_facts (
                            fact_id, document_id, revision, fact_sha256, subject,
                            predicate, object, evidence_chunk_id, attributes,
                            evidence_lightrag_chunk_id, graph_workspace, graph_edge_key
                        )
                        VALUES (
                            $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12
                        )
                        """,
                        facts,
                    )


def _required_env_or_default(name: str, default: str) -> str:
    value = os.getenv(name, default).strip()
    if not value:
        raise ValueError(f"{name} cannot be empty")
    return value


def _validate_artifact_namespace(value: str) -> None:
    if not _ARTIFACT_COMPONENT.fullmatch(value):
        raise ValueError(
            "artifact_namespace must use letters, numbers, dots, underscores, or hyphens"
        )


def _scoped_source_key(
    source_key: str, parser_name: str, workspace: str, artifact_namespace: str
) -> str:
    if parser_name != "mineru":
        return source_key
    return f"mineru-ab:{artifact_namespace}:{workspace}:{source_key}"


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while block := source.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def _copy_file_once(source: Path, destination: Path) -> None:
    if destination.exists():
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def _normalize_workspace(value: str) -> str:
    normalized = value.strip()
    if not _WORKSPACE_COMPONENT.fullmatch(normalized):
        raise ValueError(
            "workspace must use letters, numbers, dots, underscores, or hyphens"
        )
    return normalized


def _normalize_lightrag_document_id(value: Any) -> str:
    normalized = _optional_text(value)
    if not normalized:
        raise ValueError("LightRAG document or chunk ID cannot be empty")
    return normalized


def _resolve_lightrag_sidecar_dir(sidecar_uri: str, sidecar_root: Path) -> Path:
    """Resolve LightRAG's local sidecar URI without reading outside its input mount."""

    parsed = urlparse(sidecar_uri)
    if parsed.scheme != "file":
        raise RagRegistryRetryableError(
            "LightRAG sidecar is not a local file URI visible to this worker"
        )

    netloc = unquote(parsed.netloc)
    decoded_path = unquote(parsed.path)
    if netloc and netloc not in {"", "localhost"}:
        # LightRAG 1.5.4 serializes Windows paths as file://D%3A%5C.../.
        if re.fullmatch(r"[A-Za-z]:[\\/].*", netloc):
            candidate = Path(f"{netloc}{decoded_path}")
        else:
            candidate = Path(f"//{netloc}{decoded_path}")
    else:
        # A canonical Windows URI is file:///D:/path while Linux uses file:///path.
        if re.fullmatch(r"/[A-Za-z]:[\\/].*", decoded_path):
            decoded_path = decoded_path[1:]
        candidate = Path(url2pathname(decoded_path))

    if not candidate.is_absolute():
        raise RagRegistryRetryableError("LightRAG sidecar URI is not an absolute path")

    root = sidecar_root.expanduser().resolve()
    resolved = candidate.expanduser().resolve()
    if not resolved.is_relative_to(root):
        raise RagRegistryRetryableError(
            "LightRAG sidecar is outside RAG_LIGHTRAG_SIDECAR_ROOT"
        )
    if not resolved.is_dir():
        raise RagRegistryRetryableError(
            "LightRAG sidecar directory is not available to the worker"
        )
    return resolved


def _discover_blocks_jsonl(sidecar_dir: Path) -> Path:
    candidates = {
        path.resolve()
        for path in sidecar_dir.glob("*.blocks.jsonl")
        if path.is_file()
    }
    legacy = sidecar_dir / "blocks.jsonl"
    if legacy.is_file():
        candidates.add(legacy.resolve())
    if not candidates:
        raise RagRegistryRetryableError(
            "LightRAG sidecar does not yet contain a *.blocks.jsonl artifact"
        )
    if len(candidates) != 1:
        names = ", ".join(sorted(path.name for path in candidates))
        raise ValueError(f"LightRAG sidecar must contain exactly one blocks JSONL: {names}")
    return next(iter(candidates))


def _copy_directory_idempotent(source: Path, destination: Path) -> None:
    """Synchronize parser artifacts so interrupted copies can safely resume."""

    source = source.resolve()
    destination = destination.resolve()
    if not source.is_dir():
        raise RagRegistryRetryableError("LightRAG sidecar directory is unavailable")
    if source == destination:
        return
    if destination.is_relative_to(source):
        raise ValueError("Parser artifact destination cannot be inside the sidecar source")
    if destination.exists() and not destination.is_dir():
        raise ValueError(f"Parser artifact destination is not a directory: {destination}")

    destination.mkdir(parents=True, exist_ok=True)
    for source_path in sorted(source.rglob("*"), key=lambda path: path.as_posix()):
        if source_path.is_symlink():
            raise ValueError(f"Parser sidecar cannot contain symbolic links: {source_path}")
        relative_path = source_path.relative_to(source)
        destination_path = destination / relative_path
        if source_path.is_dir():
            destination_path.mkdir(parents=True, exist_ok=True)
        elif source_path.is_file():
            destination_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source_path, destination_path)
        else:
            raise ValueError(f"Parser sidecar contains an unsupported entry: {source_path}")


def _artifact_inventory(sidecar_dir: Path) -> list[ParserArtifact]:
    root = sidecar_dir.resolve()
    artifacts: list[ParserArtifact] = []
    for path in sorted(root.rglob("*"), key=lambda item: item.as_posix()):
        if not path.is_file():
            continue
        if path.is_symlink():
            raise ValueError(f"Parser artifact cannot be a symbolic link: {path}")
        relative_path = path.relative_to(root)
        artifacts.append(
            ParserArtifact(
                relative_path=relative_path.as_posix(),
                artifact_uri=path.resolve().as_uri(),
                artifact_kind=_artifact_kind(relative_path),
                content_sha256=_sha256_file(path),
                byte_size=path.stat().st_size,
            )
        )
    return artifacts


def _artifact_kind(relative_path: Path) -> str:
    name = relative_path.name
    if name.endswith(".blocks.jsonl") or name == "blocks.jsonl":
        return "blocks_jsonl"
    if name.endswith(".drawings.json"):
        return "drawings_json"
    if name.endswith(".tables.json"):
        return "tables_json"
    if name.endswith(".equations.json"):
        return "equations_json"
    if "assets" in relative_path.parts:
        return "asset"
    return "sidecar_file"


def _sidecar_modality_block_ids(sidecar_dir: Path) -> dict[tuple[str, str], str]:
    mappings: dict[tuple[str, str], str] = {}
    for modality, collection in (
        ("drawing", "drawings"),
        ("table", "tables"),
        ("equation", "equations"),
    ):
        for path in sorted(sidecar_dir.glob(f"*.{collection}.json")):
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                raise ValueError(f"Invalid sidecar modality JSON: {path}") from exc
            if not isinstance(payload, dict):
                raise ValueError(f"Sidecar modality JSON must be an object: {path}")
            items = payload.get(collection)
            if not isinstance(items, dict):
                raise ValueError(f"Sidecar modality JSON is missing {collection}: {path}")
            for raw_item_id, item in items.items():
                if not isinstance(item, dict):
                    raise ValueError(f"Sidecar modality item must be an object: {path}")
                item_id = _optional_text(item.get("id")) or _optional_text(raw_item_id)
                block_id = _optional_text(item.get("blockid"))
                if not item_id or not block_id:
                    raise ValueError(f"Sidecar modality item is missing id or blockid: {path}")
                key = (modality, item_id)
                existing = mappings.get(key)
                if existing is not None and existing != block_id:
                    raise ValueError(f"Conflicting sidecar modality mapping for {item_id}")
                mappings[key] = block_id
    return mappings


def _sidecar_block_ids(
    sidecar: dict[str, Any], modality_block_ids: dict[tuple[str, str], str]
) -> tuple[list[str], str, bool]:
    raw_refs = sidecar.get("refs")
    refs = raw_refs if isinstance(raw_refs, list) else []
    if not refs:
        refs = [{"type": sidecar.get("type"), "id": sidecar.get("id")}]

    block_ids: list[str] = []
    has_modality_ref = False
    has_unresolved_refs = False
    for ref in refs:
        if not isinstance(ref, dict):
            has_unresolved_refs = True
            continue
        ref_type = _optional_text(ref.get("type"))
        ref_id = _optional_text(ref.get("id"))
        if not ref_type or not ref_id:
            has_unresolved_refs = True
            continue
        if ref_type == "block":
            block_ids.append(ref_id)
            continue
        mapped_block_id = modality_block_ids.get((ref_type, ref_id))
        if mapped_block_id is None:
            has_unresolved_refs = True
            continue
        has_modality_ref = True
        block_ids.append(mapped_block_id)

    return (
        list(dict.fromkeys(block_ids)),
        "sidecar_modality_ref" if has_modality_ref else "sidecar_ref",
        has_unresolved_refs,
    )


def _json_object(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as exc:
            raise ValueError("LightRAG JSON field is invalid") from exc
    if not isinstance(value, dict):
        return {}
    return dict(value)


def _json_text_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as exc:
            raise ValueError("LightRAG relation chunk IDs are invalid JSON") from exc
    if not isinstance(value, list):
        raise ValueError("LightRAG relation chunk IDs must be a JSON array")
    return list(
        dict.fromkeys(
            normalized
            for item in value
            if (normalized := _optional_text(item)) is not None
        )
    )


def _optional_text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized or None


def _content_overlap_score(left: str, right: str) -> float:
    if not left or not right:
        return 0.0
    return SequenceMatcher(None, left[:8000], right[:8000], autojunk=False).ratio()


def _graphml_path(graph_working_dir: Path, workspace: str) -> Path:
    root = graph_working_dir.expanduser().resolve()
    candidate = (root / _normalize_workspace(workspace) / "graph_chunk_entity_relation.graphml").resolve()
    if not candidate.is_relative_to(root):
        raise ValueError("LightRAG graph path escapes RAG_GRAPH_WORKING_DIR")
    return candidate


def _load_graph_edges(graph_path: Path) -> dict[str, _GraphEdge]:
    if not graph_path.is_file():
        raise RagRegistryRetryableError("LightRAG GraphML output is not available")
    try:
        root = ElementTree.parse(graph_path).getroot()
    except (OSError, ElementTree.ParseError) as exc:
        raise RagRegistryRetryableError("LightRAG GraphML output is not readable") from exc

    def local_name(element: ElementTree.Element) -> str:
        return element.tag.rsplit("}", 1)[-1]

    key_names = {
        key_id: _optional_text(element.attrib.get("attr.name")) or key_id
        for element in root.iter()
        if local_name(element) == "key"
        and (key_id := _optional_text(element.attrib.get("id"))) is not None
    }
    edges: dict[str, _GraphEdge] = {}
    for element in root.iter():
        if local_name(element) != "edge":
            continue
        source = _optional_text(element.attrib.get("source"))
        target = _optional_text(element.attrib.get("target"))
        if not source or not target:
            raise ValueError("GraphML edge is missing source or target")
        attributes: dict[str, str] = {}
        for data in element:
            if local_name(data) != "data":
                continue
            key_id = _optional_text(data.attrib.get("key"))
            if not key_id:
                continue
            attributes[key_names.get(key_id, key_id)] = "".join(data.itertext()).strip()
        relation_key = _relation_key(source, target)
        if relation_key in edges:
            raise ValueError(f"GraphML contains duplicate relation edge: {relation_key}")
        edges[relation_key] = _GraphEdge(source=source, target=target, attributes=attributes)
    return edges


def _normalize_relation_key(value: str) -> str:
    parts = value.split(_GRAPH_FIELD_SEPARATOR)
    if len(parts) != 2:
        raise ValueError("LightRAG relation key must contain exactly two entity IDs")
    return _relation_key(parts[0], parts[1])


def _relation_key(source: str, target: str) -> str:
    normalized_source = _optional_text(source)
    normalized_target = _optional_text(target)
    if not normalized_source or not normalized_target:
        raise ValueError("Graph relation endpoint cannot be empty")
    if (
        _GRAPH_FIELD_SEPARATOR in normalized_source
        or _GRAPH_FIELD_SEPARATOR in normalized_target
    ):
        raise ValueError("Graph relation endpoint cannot contain the LightRAG separator")
    return _GRAPH_FIELD_SEPARATOR.join(sorted((normalized_source, normalized_target)))


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
