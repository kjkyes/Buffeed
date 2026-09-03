from __future__ import annotations

import asyncio
import hashlib
import os
import re
from dataclasses import dataclass, field
from typing import Any, Iterable, Literal, Sequence
from uuid import UUID

import asyncpg
import httpx
from lightrag.rerank import ali_rerank

from lightrag_client import LightRAGClient, LightRAGError
from rag_database import PostgresSettings, create_postgres_pool


_FTS_CONFIG = re.compile(r"^[a-z_][a-z0-9_]*$")
_READY_FOR_VECTOR = ("vector_ready", "kg_pending", "kg_running", "graph_ready")


def _env_bool(name: str, default: bool) -> bool:
    raw_value = os.getenv(name)
    if raw_value is None:
        return default
    value = raw_value.strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be a boolean")


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw_value = os.getenv(name, str(default))
    try:
        value = int(raw_value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


def _configured_secret(value: str | None) -> str | None:
    if not value:
        return None
    normalized = value.strip()
    if not normalized or normalized.startswith("replace-"):
        return None
    return normalized


def _lightrag_workspace() -> str:
    workspace = os.getenv("LIGHTRAG_WORKSPACE", "").strip()
    if not workspace:
        workspace = os.getenv("RAG_PRODUCTION_WORKSPACE", "default").strip()
    if not workspace:
        raise ValueError("LIGHTRAG_WORKSPACE cannot be empty")
    return workspace


@dataclass(frozen=True)
class HybridSettings:
    enabled: bool
    postgres_enabled: bool
    fts_config: str
    lightrag_workspace: str
    per_channel_limit: int
    final_limit: int
    rrf_k: int
    query_rewrite_enabled: bool
    query_rewrite_base_url: str | None
    query_rewrite_model: str | None
    query_rewrite_api_key: str | None
    query_rewrite_timeout_seconds: int
    rerank_enabled: bool
    rerank_api_key: str | None
    rerank_model: str
    rerank_base_url: str

    @classmethod
    def from_env(cls) -> "HybridSettings":
        fts_config = os.getenv("RAG_HYBRID_FTS_CONFIG", "simple").strip().lower()
        if not _FTS_CONFIG.fullmatch(fts_config):
            raise ValueError("RAG_HYBRID_FTS_CONFIG must be a PostgreSQL text-search config")

        rewrite_base_url = os.getenv("RAG_QUERY_REWRITE_BASE_URL", "").strip().rstrip("/")
        if not rewrite_base_url:
            rewrite_base_url = os.getenv("LLM_BINDING_HOST", "").strip().rstrip("/")
        rewrite_model = os.getenv("RAG_QUERY_REWRITE_MODEL", "").strip()
        if not rewrite_model:
            rewrite_model = os.getenv("QUERY_LLM_MODEL", "").strip() or os.getenv(
                "LLM_MODEL", ""
            ).strip()
        rewrite_api_key = _configured_secret(
            os.getenv("RAG_QUERY_REWRITE_API_KEY")
            or os.getenv("LLM_BINDING_API_KEY")
        )

        rerank_api_key = _configured_secret(
            os.getenv("DASHSCOPE_API_KEY") or os.getenv("RERANK_BINDING_API_KEY")
        )
        rerank_base_url = os.getenv("RERANK_BINDING_HOST", "").strip().rstrip("/")
        if not rerank_base_url:
            rerank_base_url = (
                "https://dashscope.aliyuncs.com/api/v1/services/rerank/"
                "text-rerank/text-rerank"
            )
        return cls(
            enabled=_env_bool("RAG_HYBRID_ENABLED", False),
            postgres_enabled=_env_bool("RAG_HYBRID_POSTGRES_ENABLED", False),
            fts_config=fts_config,
            lightrag_workspace=_lightrag_workspace(),
            per_channel_limit=_env_int("RAG_HYBRID_PER_CHANNEL_LIMIT", 24, 1, 100),
            final_limit=_env_int("RAG_HYBRID_FINAL_LIMIT", 12, 1, 50),
            rrf_k=_env_int("RAG_HYBRID_RRF_K", 60, 1, 1000),
            query_rewrite_enabled=_env_bool("RAG_QUERY_REWRITE_ENABLED", True),
            query_rewrite_base_url=rewrite_base_url or None,
            query_rewrite_model=rewrite_model or None,
            query_rewrite_api_key=rewrite_api_key,
            query_rewrite_timeout_seconds=_env_int(
                "RAG_QUERY_REWRITE_TIMEOUT_SECONDS", 15, 1, 120
            ),
            rerank_enabled=_env_bool("RAG_HYBRID_RERANK_ENABLED", True)
            and rerank_api_key is not None,
            rerank_api_key=rerank_api_key,
            rerank_model=os.getenv("RERANK_MODEL", "gte-rerank-v2").strip(),
            rerank_base_url=rerank_base_url,
        )


@dataclass
class RetrievalCandidate:
    candidate_id: str
    content: str
    channels: set[str]
    document_id: UUID | None = None
    revision: int | None = None
    chunk_id: UUID | None = None
    parent_chunk_id: UUID | None = None
    parent_content: str | None = None
    source_page: int | None = None
    source_block_id: str | None = None
    source_uri: str | None = None
    lightrag_chunk_id: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    rrf_score: float = 0.0
    rerank_score: float | None = None

    def clone(self) -> "RetrievalCandidate":
        return RetrievalCandidate(
            candidate_id=self.candidate_id,
            content=self.content,
            channels=set(self.channels),
            document_id=self.document_id,
            revision=self.revision,
            chunk_id=self.chunk_id,
            parent_chunk_id=self.parent_chunk_id,
            parent_content=self.parent_content,
            source_page=self.source_page,
            source_block_id=self.source_block_id,
            source_uri=self.source_uri,
            lightrag_chunk_id=self.lightrag_chunk_id,
            metadata=dict(self.metadata),
            rrf_score=self.rrf_score,
            rerank_score=self.rerank_score,
        )

    def as_evidence(self) -> dict[str, Any]:
        return {
            "document_id": str(self.document_id) if self.document_id else None,
            "revision": self.revision,
            "chunk_id": str(self.chunk_id) if self.chunk_id else self.lightrag_chunk_id,
            "parent_chunk_id": str(self.parent_chunk_id)
            if self.parent_chunk_id
            else None,
            "source": {
                "uri": self.source_uri,
                "page": self.source_page,
                "block_id": self.source_block_id,
            },
            "matched_chunk": self.content,
            "parent_content": self.parent_content,
            "channels": sorted(self.channels),
            "rrf_score": round(self.rrf_score, 8),
            "rerank_score": (
                round(self.rerank_score, 8) if self.rerank_score is not None else None
            ),
            "metadata": self.metadata,
        }


class PostgresHybridStore:
    def __init__(
        self, settings: PostgresSettings, fts_config: str, lightrag_workspace: str
    ) -> None:
        self._settings = settings
        self._fts_config = fts_config
        self._lightrag_workspace = lightrag_workspace
        self._pool: asyncpg.Pool | None = None
        self._pool_lock = asyncio.Lock()

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.close()
            self._pool = None

    async def fts_candidates(self, query: str, limit: int) -> list[RetrievalCandidate]:
        pool = await self._get_pool()
        async with pool.acquire() as connection:
            rows = await connection.fetch(
                """
                WITH search_query AS (
                    SELECT websearch_to_tsquery($1::regconfig, $2) AS terms
                )
                SELECT
                    c.document_id, c.revision, c.chunk_id, c.parent_chunk_id,
                    c.content, c.source_page, c.source_block_id, c.source_uri,
                    ts_rank_cd(to_tsvector($1::regconfig, c.content), search_query.terms)
                        AS lexical_score
                FROM rag.chunks AS c
                CROSS JOIN search_query
                WHERE c.chunk_kind = 'child'
                  AND to_tsvector($1::regconfig, c.content) @@ search_query.terms
                  AND EXISTS (
                      SELECT 1
                      FROM rag.ingest_tasks AS task
                      WHERE task.document_id = c.document_id
                        AND task.revision = c.revision
                        AND task.status = ANY($3::text[])
                  )
                ORDER BY lexical_score DESC, c.chunk_id
                LIMIT $4
                """,
                self._fts_config,
                query,
                list(_READY_FOR_VECTOR),
                limit,
            )
        return [_row_to_candidate(row, "fts") for row in rows]

    async def kg_candidates(self, query: str, limit: int) -> list[RetrievalCandidate]:
        pool = await self._get_pool()
        async with pool.acquire() as connection:
            rows = await connection.fetch(
                """
                WITH search_query AS (
                    SELECT websearch_to_tsquery($1::regconfig, $2) AS terms
                )
                SELECT
                    fact.fact_id, fact.document_id, fact.revision,
                    chunk.chunk_id, chunk.parent_chunk_id, chunk.source_page,
                    chunk.source_block_id, chunk.source_uri,
                    fact.subject || ' ' || fact.predicate || ' ' || fact.object AS content,
                    ts_rank_cd(
                        to_tsvector(
                            $1::regconfig,
                            fact.subject || ' ' || fact.predicate || ' ' || fact.object
                        ),
                        search_query.terms
                    ) AS graph_score
                FROM rag.graph_facts AS fact
                LEFT JOIN rag.chunks AS chunk ON chunk.chunk_id = fact.evidence_chunk_id
                CROSS JOIN search_query
                WHERE to_tsvector(
                        $1::regconfig,
                        fact.subject || ' ' || fact.predicate || ' ' || fact.object
                    ) @@ search_query.terms
                  AND EXISTS (
                      SELECT 1
                      FROM rag.ingest_tasks AS task
                      WHERE task.document_id = fact.document_id
                        AND task.revision = fact.revision
                        AND task.status = 'graph_ready'
                  )
                ORDER BY graph_score DESC, fact.fact_id
                LIMIT $3
                """,
                self._fts_config,
                query,
                limit,
            )
        candidates: list[RetrievalCandidate] = []
        for row in rows:
            chunk_id = row["chunk_id"]
            candidates.append(
                RetrievalCandidate(
                    candidate_id=(
                        f"chunk:{chunk_id}" if chunk_id else f"fact:{row['fact_id']}"
                    ),
                    content=row["content"],
                    channels={"kg"},
                    document_id=row["document_id"],
                    revision=row["revision"],
                    chunk_id=chunk_id,
                    parent_chunk_id=row["parent_chunk_id"],
                    source_page=row["source_page"],
                    source_block_id=row["source_block_id"],
                    source_uri=row["source_uri"],
                    metadata={"fact_id": str(row["fact_id"])},
                )
            )
        return candidates

    async def attach_vector_provenance(
        self, candidates: list[RetrievalCandidate]
    ) -> list[RetrievalCandidate]:
        lightrag_ids = sorted(
            {
                candidate.lightrag_chunk_id
                for candidate in candidates
                if candidate.lightrag_chunk_id
            }
        )
        if not lightrag_ids:
            return candidates

        pool = await self._get_pool()
        async with pool.acquire() as connection:
            rows = await connection.fetch(
                """
                SELECT
                    link.lightrag_chunk_id, chunk.document_id, chunk.revision,
                    chunk.chunk_id, chunk.parent_chunk_id, chunk.content,
                    chunk.source_page, chunk.source_block_id, chunk.source_uri
                FROM rag.lightrag_chunk_links AS link
                JOIN rag.chunks AS chunk ON chunk.chunk_id = link.chunk_id
                WHERE link.workspace = $1
                  AND link.is_primary
                  AND link.lightrag_chunk_id = ANY($2::text[])
                """,
                self._lightrag_workspace,
                lightrag_ids,
            )
        provenance = {row["lightrag_chunk_id"]: row for row in rows}
        unresolved_ids = sorted(set(lightrag_ids).difference(provenance))
        if unresolved_ids:
            async with pool.acquire() as connection:
                legacy_rows = await connection.fetch(
                    """
                    SELECT
                        chunk.lightrag_chunk_id, chunk.document_id, chunk.revision,
                        chunk.chunk_id, chunk.parent_chunk_id, chunk.content,
                        chunk.source_page, chunk.source_block_id, chunk.source_uri
                    FROM rag.chunks AS chunk
                    WHERE chunk.lightrag_chunk_id = ANY($2::text[])
                      AND NOT EXISTS (
                          SELECT 1
                          FROM rag.lightrag_chunk_links AS link
                          WHERE link.workspace = $1
                            AND link.lightrag_chunk_id = chunk.lightrag_chunk_id
                            AND link.is_primary
                      )
                    """,
                    self._lightrag_workspace,
                    unresolved_ids,
                )
            for row in legacy_rows:
                provenance.setdefault(row["lightrag_chunk_id"], row)
        for candidate in candidates:
            if not candidate.lightrag_chunk_id:
                continue
            row = provenance.get(candidate.lightrag_chunk_id)
            if row is None:
                continue
            candidate.candidate_id = f"chunk:{row['chunk_id']}"
            candidate.document_id = row["document_id"]
            candidate.revision = row["revision"]
            candidate.chunk_id = row["chunk_id"]
            candidate.parent_chunk_id = row["parent_chunk_id"]
            candidate.content = row["content"]
            candidate.source_page = row["source_page"]
            candidate.source_block_id = row["source_block_id"]
            candidate.source_uri = row["source_uri"]
        return candidates

    async def attach_parent_content(
        self, candidates: Sequence[RetrievalCandidate]
    ) -> None:
        parent_ids = sorted(
            {
                candidate.parent_chunk_id
                for candidate in candidates
                if candidate.parent_chunk_id is not None
            },
            key=str,
        )
        if not parent_ids:
            return
        pool = await self._get_pool()
        async with pool.acquire() as connection:
            rows = await connection.fetch(
                "SELECT chunk_id, content FROM rag.chunks WHERE chunk_id = ANY($1::uuid[])",
                parent_ids,
            )
        parent_content = {row["chunk_id"]: row["content"] for row in rows}
        for candidate in candidates:
            if candidate.parent_chunk_id is not None:
                candidate.parent_content = parent_content.get(candidate.parent_chunk_id)

    async def _get_pool(self) -> asyncpg.Pool:
        if self._pool is not None:
            return self._pool
        async with self._pool_lock:
            if self._pool is None:
                self._pool = await create_postgres_pool(self._settings)
        return self._pool


class HybridRetriever:
    def __init__(
        self,
        client: LightRAGClient,
        settings: HybridSettings,
        postgres_store: PostgresHybridStore | None,
    ) -> None:
        self._client = client
        self._settings = settings
        self._postgres_store = postgres_store

    @classmethod
    def from_env(cls, client: LightRAGClient) -> "HybridRetriever":
        settings = HybridSettings.from_env()
        postgres_store = None
        if settings.postgres_enabled:
            postgres_store = PostgresHybridStore(
                PostgresSettings.from_env(),
                settings.fts_config,
                settings.lightrag_workspace,
            )
        return cls(client, settings, postgres_store)

    @property
    def enabled(self) -> bool:
        return self._settings.enabled

    async def close(self) -> None:
        if self._postgres_store is not None:
            await self._postgres_store.close()

    async def retrieve(
        self,
        query: str,
        *,
        top_k: int,
        chunk_top_k: int,
        max_total_tokens: int,
        enable_rerank: bool,
    ) -> dict[str, Any]:
        original_query = query.strip()
        if len(original_query) < 3:
            raise LightRAGError("query must contain at least 3 characters")

        query_variants, warnings = await self._query_variants(original_query)
        channel_lists: dict[str, list[list[RetrievalCandidate]]] = {
            "vector": [],
            "fts": [],
            "kg": [],
        }
        channel_errors: dict[str, list[str]] = {"vector": [], "fts": [], "kg": []}

        batches = await asyncio.gather(
            *(
                self._retrieve_for_query(
                    query_variant, top_k, chunk_top_k, max_total_tokens
                )
                for query_variant in query_variants
            )
        )
        for batch in batches:
            for channel, result in batch.items():
                if isinstance(result, Exception):
                    channel_errors[channel].append(result.__class__.__name__)
                else:
                    channel_lists[channel].append(result)

        fused_channels = {
            channel: reciprocal_rank_fusion(results, self._settings.rrf_k)
            for channel, results in channel_lists.items()
            if results
        }
        fused = reciprocal_rank_fusion(
            list(fused_channels.values()), self._settings.rrf_k
        )
        if self._postgres_store is not None and fused:
            try:
                await self._postgres_store.attach_parent_content(fused)
            except Exception as exc:
                warnings.append(f"parent_backfill:{exc.__class__.__name__}")

        reranked = await self._rerank(
            original_query, fused, warnings, enable_rerank=enable_rerank
        )
        for channel, errors in channel_errors.items():
            if errors:
                warnings.append(f"{channel}:{','.join(sorted(set(errors)))}")

        return {
            "status": "success",
            "query": original_query,
            "query_variants": query_variants,
            "retrieval": {
                "channels": {
                    channel: len(candidates)
                    for channel, candidates in fused_channels.items()
                },
                "rrf_k": self._settings.rrf_k,
                "rerank": (
                    "dashscope"
                    if self._settings.rerank_enabled and enable_rerank
                    else "disabled"
                ),
            },
            "evidence": [candidate.as_evidence() for candidate in reranked],
            "warnings": warnings,
        }

    async def _retrieve_for_query(
        self,
        query: str,
        top_k: int,
        chunk_top_k: int,
        max_total_tokens: int,
    ) -> dict[str, list[RetrievalCandidate] | Exception]:
        tasks: dict[str, Any] = {
            "vector": self._vector_candidates(
                query, top_k, chunk_top_k, max_total_tokens
            )
        }
        if self._postgres_store is not None:
            tasks["fts"] = self._postgres_store.fts_candidates(
                query, self._settings.per_channel_limit
            )
            tasks["kg"] = self._postgres_store.kg_candidates(
                query, self._settings.per_channel_limit
            )
        else:
            tasks["fts"] = _empty_candidates()
            tasks["kg"] = _empty_candidates()

        names = list(tasks)
        results = await asyncio.gather(*tasks.values(), return_exceptions=True)
        output = dict(zip(names, results, strict=True))
        vector_result = output["vector"]
        if self._postgres_store is not None and isinstance(vector_result, list):
            try:
                output["vector"] = await self._postgres_store.attach_vector_provenance(
                    vector_result
                )
            except Exception as exc:
                output["vector_provenance"] = exc
        return {
            "vector": output["vector"],
            "fts": output["fts"],
            "kg": output["kg"],
        }

    async def _vector_candidates(
        self,
        query: str,
        top_k: int,
        chunk_top_k: int,
        max_total_tokens: int,
    ) -> list[RetrievalCandidate]:
        payload = await self._client.request(
            "POST",
            "/query/data",
            json={
                "query": query,
                "mode": "naive",
                "top_k": top_k,
                "chunk_top_k": chunk_top_k,
                "max_total_tokens": max_total_tokens,
                "enable_rerank": False,
            },
        )
        return _extract_vector_candidates(payload)

    async def _query_variants(self, original_query: str) -> tuple[list[str], list[str]]:
        warnings: list[str] = []
        if not self._settings.query_rewrite_enabled:
            return [original_query], warnings
        if not (
            self._settings.query_rewrite_base_url
            and self._settings.query_rewrite_model
            and self._settings.query_rewrite_api_key
        ):
            warnings.append("query_rewrite:not_configured")
            return [original_query], warnings

        endpoint = self._settings.query_rewrite_base_url
        if not endpoint.endswith("/chat/completions"):
            endpoint = f"{endpoint}/chat/completions"
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(self._settings.query_rewrite_timeout_seconds)
            ) as client:
                response = await client.post(
                    endpoint,
                    headers={
                        "Authorization": f"Bearer {self._settings.query_rewrite_api_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": self._settings.query_rewrite_model,
                        "temperature": 0,
                        "max_tokens": 128,
                        "messages": [
                            {
                                "role": "system",
                                "content": "Rewrite the user query for document retrieval. Return only one concise search query without explanation.",
                            },
                            {"role": "user", "content": original_query},
                        ],
                    },
                )
                response.raise_for_status()
                payload = response.json()
            rewrite = _extract_chat_content(payload)
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
            warnings.append(f"query_rewrite:{exc.__class__.__name__}")
            return [original_query], warnings

        if not rewrite or rewrite == original_query:
            return [original_query], warnings
        return [original_query, rewrite], warnings

    async def _rerank(
        self,
        query: str,
        candidates: list[RetrievalCandidate],
        warnings: list[str],
        *,
        enable_rerank: bool,
    ) -> list[RetrievalCandidate]:
        limited = candidates[: self._settings.per_channel_limit]
        if not limited:
            return []
        if not self._settings.rerank_enabled or not enable_rerank:
            return limited[: self._settings.final_limit]

        try:
            rankings = await ali_rerank(
                query=query,
                documents=[candidate.content for candidate in limited],
                top_n=self._settings.final_limit,
                api_key=self._settings.rerank_api_key,
                model=self._settings.rerank_model,
                base_url=self._settings.rerank_base_url,
            )
            reranked: list[RetrievalCandidate] = []
            for item in rankings:
                index = item.get("index")
                score = item.get("relevance_score")
                if not isinstance(index, int) or not 0 <= index < len(limited):
                    continue
                candidate = limited[index]
                candidate.rerank_score = float(score) if isinstance(score, (int, float)) else None
                reranked.append(candidate)
            if reranked:
                return reranked
            warnings.append("rerank:empty_response")
        except Exception as exc:
            warnings.append(f"rerank:{exc.__class__.__name__}")
        return limited[: self._settings.final_limit]


async def _empty_candidates() -> list[RetrievalCandidate]:
    return []


def reciprocal_rank_fusion(
    ranked_lists: Iterable[Sequence[RetrievalCandidate]], rrf_k: int
) -> list[RetrievalCandidate]:
    fused: dict[str, RetrievalCandidate] = {}
    for ranked in ranked_lists:
        for rank, candidate in enumerate(ranked, start=1):
            current = fused.get(candidate.candidate_id)
            if current is None:
                current = candidate.clone()
                current.rrf_score = 0.0
                fused[current.candidate_id] = current
            else:
                current.channels.update(candidate.channels)
                _merge_missing_provenance(current, candidate)
            current.rrf_score += 1.0 / (rrf_k + rank)
    return sorted(fused.values(), key=lambda item: (-item.rrf_score, item.candidate_id))


def _merge_missing_provenance(
    target: RetrievalCandidate, source: RetrievalCandidate
) -> None:
    for field_name in (
        "document_id",
        "revision",
        "chunk_id",
        "parent_chunk_id",
        "parent_content",
        "source_page",
        "source_block_id",
        "source_uri",
        "lightrag_chunk_id",
    ):
        if getattr(target, field_name) is None:
            setattr(target, field_name, getattr(source, field_name))
    if not target.content and source.content:
        target.content = source.content
    target.metadata.update(source.metadata)


def _extract_vector_candidates(payload: dict[str, Any]) -> list[RetrievalCandidate]:
    data = payload.get("data")
    if not isinstance(data, dict):
        return []
    raw_references = data.get("references")
    references = raw_references if isinstance(raw_references, list) else []
    reference_map = {
        str(item.get("reference_id")): item
        for item in references
        if isinstance(item, dict)
        and item.get("reference_id") is not None
    }
    chunks = data.get("chunks")
    if not isinstance(chunks, list):
        return []

    candidates: list[RetrievalCandidate] = []
    for ordinal, raw_chunk in enumerate(chunks):
        if not isinstance(raw_chunk, dict):
            continue
        content = _first_text(raw_chunk, "content", "text", "description")
        if not content:
            continue
        reference_id = _first_text(raw_chunk, "reference_id")
        reference = reference_map.get(reference_id or "", {})
        lightrag_chunk_id = _first_text(raw_chunk, "chunk_id", "id", "reference_id")
        source_uri = _first_text(raw_chunk, "file_path", "source_uri") or _first_text(
            reference, "file_path", "source_uri"
        )
        source_page = _first_page(raw_chunk)
        if source_page is None:
            source_page = _first_page(reference)
        candidate_key = lightrag_chunk_id or hashlib.sha256(
            f"{source_uri}:{content}:{ordinal}".encode("utf-8")
        ).hexdigest()
        candidates.append(
            RetrievalCandidate(
                candidate_id=f"vector:{candidate_key}",
                content=content,
                channels={"vector"},
                source_page=source_page,
                source_uri=source_uri,
                lightrag_chunk_id=lightrag_chunk_id,
                metadata={"reference_id": reference_id} if reference_id else {},
            )
        )
    return candidates


def _row_to_candidate(row: asyncpg.Record, channel: str) -> RetrievalCandidate:
    chunk_id = row["chunk_id"]
    return RetrievalCandidate(
        candidate_id=f"chunk:{chunk_id}",
        content=row["content"],
        channels={channel},
        document_id=row["document_id"],
        revision=row["revision"],
        chunk_id=chunk_id,
        parent_chunk_id=row["parent_chunk_id"],
        source_page=row["source_page"],
        source_block_id=row["source_block_id"],
        source_uri=row["source_uri"],
    )


def _first_text(item: dict[str, Any], *names: str) -> str | None:
    for name in names:
        value = item.get(name)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _first_page(item: dict[str, Any]) -> int | None:
    for name in ("page", "page_no", "page_number"):
        value = item.get(name)
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            return value
        if isinstance(value, str) and value.isdigit():
            return int(value)
    return None


def _extract_chat_content(payload: dict[str, Any]) -> str | None:
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return None
    first = choices[0]
    if not isinstance(first, dict):
        return None
    message = first.get("message")
    if not isinstance(message, dict):
        return None
    content = message.get("content")
    if not isinstance(content, str):
        return None
    normalized = " ".join(content.strip().split())
    return normalized or None
