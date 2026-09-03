from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, Sequence
from uuid import UUID, uuid5


ChunkKind = Literal["parent", "child"]


@dataclass(frozen=True)
class DoclingBlock:
    block_id: str
    content: str
    heading: str | None
    parent_headings: tuple[str, ...]
    level: int | None
    positions: tuple[dict[str, Any], ...]
    source_page: int | None


@dataclass(frozen=True)
class ParentChildChunk:
    chunk_id: UUID
    document_id: UUID
    revision: int
    ordinal: int
    chunk_kind: ChunkKind
    parent_chunk_id: UUID | None
    content: str
    content_sha256: str
    source_page: int | None
    source_block_id: str | None
    source_uri: str
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class _ChildPart:
    block: DoclingBlock
    content: str
    source_ordinal: int
    part_index: int
    part_count: int


@dataclass
class _ParentGroup:
    heading_path: tuple[str, ...]
    segment: int
    children: list[_ChildPart] = field(default_factory=list)
    content_length: int = 0


def load_docling_blocks(blocks_path: Path) -> list[DoclingBlock]:
    """Load the stable provenance fields emitted by LightRAG's Docling sidecar."""

    blocks: list[DoclingBlock] = []
    current_marker_page: int | None = None
    with blocks_path.open("r", encoding="utf-8") as source:
        for line_number, raw_line in enumerate(source, start=1):
            if not raw_line.strip():
                continue
            try:
                item = json.loads(raw_line)
            except json.JSONDecodeError as exc:
                raise ValueError(
                    f"Invalid JSON in {blocks_path} at line {line_number}"
                ) from exc
            if not isinstance(item, dict):
                raise ValueError(
                    f"Docling block at line {line_number} must be a JSON object"
                )
            if item.get("type") == "meta":
                continue

            block_id = _required_text(item.get("blockid"), "blockid", line_number)
            content = _optional_text(item.get("content"))
            if not content:
                continue
            marker_page = _source_page_marker(content)
            if marker_page is not None:
                current_marker_page = marker_page

            raw_headings = item.get("parent_headings", [])
            parent_headings = _normalize_headings(raw_headings, line_number)
            raw_heading = _optional_text(item.get("heading"))
            raw_level = item.get("level")
            level = raw_level if isinstance(raw_level, int) and not isinstance(raw_level, bool) else None
            positions = _normalize_positions(item.get("positions"), line_number)
            blocks.append(
                DoclingBlock(
                    block_id=block_id,
                    content=content,
                    heading=raw_heading,
                    parent_headings=parent_headings,
                    level=level,
                    positions=positions,
                    source_page=marker_page or current_marker_page,
                )
            )
    return blocks


def build_parent_child_chunks(
    blocks: Sequence[DoclingBlock],
    *,
    document_id: UUID,
    revision: int,
    source_uri: str,
    sidecar_uri: str,
    max_child_chars: int = 1800,
    max_parent_chars: int = 8000,
) -> list[ParentChildChunk]:
    """Build deterministic parent and child chunks without losing Docling provenance."""

    if revision < 1:
        raise ValueError("revision must be at least 1")
    if not source_uri.strip():
        raise ValueError("source_uri cannot be empty")
    if not sidecar_uri.strip():
        raise ValueError("sidecar_uri cannot be empty")
    if max_child_chars < 256:
        raise ValueError("max_child_chars must be at least 256")
    if max_parent_chars < max_child_chars:
        raise ValueError("max_parent_chars must be at least max_child_chars")

    groups = _group_blocks(blocks, max_child_chars, max_parent_chars)
    chunks: list[ParentChildChunk] = []
    ordinal = 0

    for group in groups:
        parent_id = uuid5(
            document_id,
            f"revision={revision}:parent:{group.segment}:{'\x1f'.join(group.heading_path)}",
        )
        parent_content = _parent_content(group)
        first_page = _first_page(group.children)
        parent_metadata = {
            "heading_path": list(group.heading_path),
            "sidecar_uri": sidecar_uri,
            "child_block_ids": [child.block.block_id for child in group.children],
        }
        chunks.append(
            ParentChildChunk(
                chunk_id=parent_id,
                document_id=document_id,
                revision=revision,
                ordinal=ordinal,
                chunk_kind="parent",
                parent_chunk_id=None,
                content=parent_content,
                content_sha256=_sha256(parent_content),
                source_page=first_page,
                source_block_id=None,
                source_uri=source_uri,
                metadata=parent_metadata,
            )
        )
        ordinal += 1

        for child in group.children:
            child_id = uuid5(
                document_id,
                "revision={revision}:child:{block_id}:{source_ordinal}:{part_index}:{parent_id}".format(
                    revision=revision,
                    block_id=child.block.block_id,
                    source_ordinal=child.source_ordinal,
                    part_index=child.part_index,
                    parent_id=parent_id,
                ),
            )
            child_metadata = {
                "heading": child.block.heading,
                "parent_headings": list(child.block.parent_headings),
                "level": child.block.level,
                "positions": list(child.block.positions),
                "sidecar_uri": sidecar_uri,
                "content_part": child.part_index + 1,
                "content_parts": child.part_count,
            }
            chunks.append(
                ParentChildChunk(
                    chunk_id=child_id,
                    document_id=document_id,
                    revision=revision,
                    ordinal=ordinal,
                    chunk_kind="child",
                    parent_chunk_id=parent_id,
                    content=child.content,
                    content_sha256=_sha256(child.content),
                    source_page=_block_source_page(child.block),
                    source_block_id=child.block.block_id,
                    source_uri=source_uri,
                    metadata=child_metadata,
                )
            )
            ordinal += 1

    return chunks


def build_parent_child_chunks_from_sidecar(
    blocks_path: Path,
    *,
    document_id: UUID,
    revision: int,
    source_uri: str,
    max_child_chars: int = 1800,
    max_parent_chars: int = 8000,
) -> list[ParentChildChunk]:
    resolved_blocks_path = blocks_path.resolve()
    return build_parent_child_chunks(
        load_docling_blocks(resolved_blocks_path),
        document_id=document_id,
        revision=revision,
        source_uri=source_uri,
        sidecar_uri=resolved_blocks_path.as_uri(),
        max_child_chars=max_child_chars,
        max_parent_chars=max_parent_chars,
    )


def _group_blocks(
    blocks: Sequence[DoclingBlock],
    max_child_chars: int,
    max_parent_chars: int,
) -> list[_ParentGroup]:
    groups: list[_ParentGroup] = []
    current: _ParentGroup | None = None
    segment = 0

    for source_ordinal, block in enumerate(blocks):
        parts = _split_text(block.content, max_child_chars)
        for part_index, content in enumerate(parts):
            heading_path = _heading_path(block)
            projected_length = len(content) if current is None else current.content_length + 2 + len(content)
            if (
                current is None
                or current.heading_path != heading_path
                or projected_length > max_parent_chars
            ):
                current = _ParentGroup(heading_path=heading_path, segment=segment)
                segment += 1
                groups.append(current)

            current.children.append(
                _ChildPart(
                    block=block,
                    content=content,
                    source_ordinal=source_ordinal,
                    part_index=part_index,
                    part_count=len(parts),
                )
            )
            current.content_length += len(content) if not current.content_length else len(content) + 2

    return groups


def _heading_path(block: DoclingBlock) -> tuple[str, ...]:
    if block.parent_headings:
        return block.parent_headings
    if block.heading:
        return (block.heading,)
    return ("Document",)


def _parent_content(group: _ParentGroup) -> str:
    prefix = " > ".join(group.heading_path)
    body = "\n\n".join(child.content for child in group.children)
    return f"{prefix}\n\n{body}" if prefix else body


def _split_text(content: str, max_chars: int) -> list[str]:
    remaining = content.strip()
    parts: list[str] = []
    while remaining:
        if len(remaining) <= max_chars:
            parts.append(remaining)
            break

        split_at = max(
            remaining.rfind("\n\n", 0, max_chars),
            remaining.rfind("\n", 0, max_chars),
            remaining.rfind(" ", 0, max_chars),
        )
        if split_at < max_chars // 2:
            split_at = max_chars
        part = remaining[:split_at].strip()
        if not part:
            split_at = max_chars
            part = remaining[:split_at]
        parts.append(part)
        remaining = remaining[split_at:].lstrip()
    return parts


def _first_page(children: Sequence[_ChildPart]) -> int | None:
    for child in children:
        page = _block_source_page(child.block)
        if page is not None:
            return page
    return None


def _page_from_positions(positions: Sequence[dict[str, Any]]) -> int | None:
    for position in positions:
        field_names = ("page_no", "page_number", "page")
        if position.get("type") == "bbox":
            field_names += ("anchor",)
        for field_name in field_names:
            raw_page = position.get(field_name)
            if isinstance(raw_page, int) and not isinstance(raw_page, bool) and raw_page >= 0:
                return raw_page
            if isinstance(raw_page, str) and raw_page.isdigit():
                return int(raw_page)
    return None


def _block_source_page(block: DoclingBlock) -> int | None:
    return block.source_page or _page_from_positions(block.positions)


def _source_page_marker(content: str) -> int | None:
    match = re.search(r"\[Source page:\s*([1-9][0-9]*)\]", content, re.IGNORECASE)
    return int(match.group(1)) if match else None


def _normalize_headings(raw_headings: Any, line_number: int) -> tuple[str, ...]:
    if raw_headings is None:
        return ()
    if isinstance(raw_headings, str):
        return (raw_headings.strip(),) if raw_headings.strip() else ()
    if not isinstance(raw_headings, list):
        raise ValueError(f"parent_headings at line {line_number} must be a list or string")
    return tuple(
        value.strip()
        for value in raw_headings
        if isinstance(value, str) and value.strip()
    )


def _normalize_positions(raw_positions: Any, line_number: int) -> tuple[dict[str, Any], ...]:
    if raw_positions is None:
        return ()
    items = raw_positions if isinstance(raw_positions, list) else [raw_positions]
    if not all(isinstance(item, dict) for item in items):
        raise ValueError(f"positions at line {line_number} must be an object or list of objects")
    return tuple(dict(item) for item in items)


def _required_text(value: Any, field_name: str, line_number: int) -> str:
    normalized = _optional_text(value)
    if not normalized:
        raise ValueError(f"{field_name} at line {line_number} must be a non-empty string")
    return normalized


def _optional_text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized or None


def _sha256(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()
