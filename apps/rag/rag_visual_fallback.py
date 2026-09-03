from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse

import httpx
from pypdf import PdfReader


ProcessingProfile = Literal["text", "visual", "table", "full"]

_VISUAL_PROFILES = frozenset({"visual", "table", "full"})
_IMAGE_MEDIA_TYPES = {
    ".bmp": "image/bmp",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".webp": "image/webp",
}
_OFFICE_SUFFIXES = frozenset(
    {
        ".doc",
        ".docm",
        ".docx",
        ".odp",
        ".ods",
        ".odt",
        ".ppt",
        ".pptm",
        ".pptx",
        ".rtf",
        ".xls",
        ".xlsm",
        ".xlsx",
    }
)
_PROMPT_VERSION = "page-transcription-v1"
_MAX_CONTROL_CHARACTER_RATIO = 0.05


class VisualFallbackError(RuntimeError):
    pass


@dataclass(frozen=True)
class VisualFallbackSettings:
    enabled: bool
    min_text_chars: int
    render_dpi: int
    max_pages: int
    request_timeout_seconds: int
    max_tokens: int
    cache_root: Path
    base_url: str | None
    api_key: str | None
    model: str | None
    office_conversion_enabled: bool
    office_converter: str
    office_conversion_timeout_seconds: int

    @classmethod
    def from_env(cls, *, default_cache_root: Path) -> "VisualFallbackSettings":
        base_url = _first_env(
            "RAG_VISUAL_FALLBACK_VLM_BASE_URL",
            "VLM_LLM_BINDING_HOST",
            "LLM_BINDING_HOST",
        )
        if base_url:
            parsed = urlparse(base_url)
            if parsed.scheme not in {"http", "https"} or not parsed.netloc:
                raise ValueError(
                    "RAG_VISUAL_FALLBACK_VLM_BASE_URL must be an http or https URL"
                )
        return cls(
            enabled=_env_bool("RAG_VISUAL_FALLBACK_ENABLED", True),
            min_text_chars=_env_int(
                "RAG_VISUAL_FALLBACK_MIN_TEXT_CHARS", 80, 1, 100000
            ),
            render_dpi=_env_int("RAG_VISUAL_FALLBACK_RENDER_DPI", 180, 72, 600),
            max_pages=_env_int("RAG_VISUAL_FALLBACK_MAX_PAGES", 50, 1, 10000),
            request_timeout_seconds=_env_int(
                "RAG_VISUAL_FALLBACK_VLM_TIMEOUT_SECONDS", 90, 5, 600
            ),
            max_tokens=_env_int(
                "RAG_VISUAL_FALLBACK_VLM_MAX_TOKENS", 4000, 128, 32000
            ),
            cache_root=_env_path(
                "RAG_VISUAL_FALLBACK_CACHE_ROOT", default_cache_root
            ),
            base_url=base_url,
            api_key=_first_env(
                "RAG_VISUAL_FALLBACK_VLM_API_KEY",
                "VLM_LLM_BINDING_API_KEY",
                "LLM_BINDING_API_KEY",
            ),
            model=_first_env(
                "RAG_VISUAL_FALLBACK_VLM_MODEL", "VLM_LLM_MODEL", "LLM_MODEL"
            ),
            office_conversion_enabled=_env_bool(
                "RAG_OFFICE_CONVERSION_ENABLED", True
            ),
            office_converter=_env_text("RAG_OFFICE_CONVERTER", "soffice"),
            office_conversion_timeout_seconds=_env_int(
                "RAG_OFFICE_CONVERSION_TIMEOUT_SECONDS", 180, 10, 1800
            ),
        )


@dataclass(frozen=True)
class PageRoute:
    page: int
    route: Literal["native_pdf_text", "full_page_vlm"]
    reason: str
    canonical_source: Literal["embedded_pdf_text", "vlm_transcription"]
    native_text_chars: int
    control_character_ratio: float
    status: Literal["ready", "pending", "processing", "cached", "completed", "failed"]
    vlm_cache_hit: bool | None = None
    error: str | None = None


@dataclass(frozen=True)
class PreparedUpload:
    path: Path
    upload_name: str | None
    fallback_pages: tuple[int, ...]
    page_routes: tuple[PageRoute, ...] = ()


class VisualTextFallback:
    def __init__(self, settings: VisualFallbackSettings) -> None:
        self._settings = settings

    async def prepare(
        self,
        source_path: Path,
        processing_profile: ProcessingProfile,
        upload_name: str,
        *,
        page_routing_manifest_path: Path | None = None,
    ) -> PreparedUpload:
        suffix = source_path.suffix.lower()
        if suffix == ".pdf":
            return await self._prepare_pdf(
                source_path,
                processing_profile,
                upload_name,
                page_routing_manifest_path,
            )
        if (
            self._settings.office_conversion_enabled
            and processing_profile in _VISUAL_PROFILES
            and suffix in _OFFICE_SUFFIXES
        ):
            return await self._prepare_office_document(
                source_path,
                processing_profile,
                upload_name,
                page_routing_manifest_path,
            )
        if (
            self._settings.enabled
            and processing_profile in _VISUAL_PROFILES
            and suffix in _IMAGE_MEDIA_TYPES
        ):
            return await self._prepare_image(
                source_path,
                processing_profile,
                upload_name,
                page_routing_manifest_path,
            )
        return PreparedUpload(source_path, None, ())

    async def _prepare_office_document(
        self,
        source_path: Path,
        processing_profile: ProcessingProfile,
        upload_name: str,
        page_routing_manifest_path: Path | None,
    ) -> PreparedUpload:
        converted_pdf = await asyncio.to_thread(
            self._convert_office_document, source_path
        )
        return await self._prepare_pdf(
            converted_pdf,
            processing_profile,
            upload_name,
            page_routing_manifest_path,
            original_source_path=source_path,
            source_kind="office",
            conversion={
                "method": "libreoffice",
                "source_suffix": source_path.suffix.lower(),
                "rendered_file": converted_pdf.name,
            },
        )

    async def _prepare_pdf(
        self,
        source_path: Path,
        processing_profile: ProcessingProfile,
        upload_name: str,
        page_routing_manifest_path: Path | None,
        *,
        original_source_path: Path | None = None,
        source_kind: str = "pdf",
        conversion: dict[str, str] | None = None,
    ) -> PreparedUpload:
        page_texts = await asyncio.to_thread(_extract_pdf_texts, source_path)
        page_routes = [
            _pdf_page_route(
                index + 1,
                page_text,
                processing_profile,
                enabled=self._settings.enabled,
                min_text_chars=self._settings.min_text_chars,
            )
            for index, page_text in enumerate(page_texts)
        ]
        fallback_indexes = [
            index for index, route in enumerate(page_routes) if route.route == "full_page_vlm"
        ]
        fallback_page_numbers = tuple(index + 1 for index in fallback_indexes)
        manifest_paths = (page_routing_manifest_path,) if page_routing_manifest_path else ()
        manifest_source_file = (
            original_source_path.name if original_source_path else source_path.name
        )
        manifest_kwargs = {
            "source_file": manifest_source_file,
            "source_kind": source_kind,
            "rendered_file": source_path.name if original_source_path else None,
            "conversion": conversion,
        }
        await self._write_page_routing_manifest(
            manifest_paths,
            source_path,
            processing_profile,
            page_routes,
            **manifest_kwargs,
        )
        if not fallback_indexes:
            return PreparedUpload(
                original_source_path or source_path,
                None,
                (),
                tuple(page_routes),
            )
        if len(fallback_indexes) > self._settings.max_pages:
            detail = (
                "Visual text fallback would process "
                f"{len(fallback_indexes)} full-page VLM pages, exceeding "
                "RAG_VISUAL_FALLBACK_MAX_PAGES="
                f"{self._settings.max_pages}"
            )
            failed_routes = [
                replace(route, status="failed", error=detail)
                if route.route == "full_page_vlm"
                else route
                for route in page_routes
            ]
            await self._write_page_routing_manifest(
                manifest_paths,
                source_path,
                processing_profile,
                failed_routes,
                **manifest_kwargs,
            )
            raise VisualFallbackError(detail)

        cache_dir = await asyncio.to_thread(self._cache_dir, source_path)
        manifest_paths = (*manifest_paths, cache_dir / "manifest.json")
        fallback_texts: dict[int, str] = {}
        try:
            async with self._vision_client() as client:
                for page_index in fallback_indexes:
                    page_routes[page_index] = replace(
                        page_routes[page_index], status="processing"
                    )
                    await self._write_page_routing_manifest(
                        manifest_paths,
                        source_path,
                        processing_profile,
                        page_routes,
                        **manifest_kwargs,
                    )
                    try:
                        transcription, cache_hit = await self._transcribe_pdf_page(
                            client, source_path, page_index, cache_dir
                        )
                    except VisualFallbackError as exc:
                        page_routes[page_index] = replace(
                            page_routes[page_index], status="failed", error=str(exc)[:500]
                        )
                        await self._write_page_routing_manifest(
                            manifest_paths,
                            source_path,
                            processing_profile,
                            page_routes,
                            **manifest_kwargs,
                        )
                        raise
                    fallback_texts[page_index] = transcription
                    page_routes[page_index] = replace(
                        page_routes[page_index],
                        status="cached" if cache_hit else "completed",
                        vlm_cache_hit=cache_hit,
                    )
                    await self._write_page_routing_manifest(
                        manifest_paths,
                        source_path,
                        processing_profile,
                        page_routes,
                        **manifest_kwargs,
                    )
        except VisualFallbackError as exc:
            failed_routes = [
                replace(route, status="failed", error=str(exc)[:500])
                if route.route == "full_page_vlm" and route.status in {"pending", "processing"}
                else route
                for route in page_routes
            ]
            await self._write_page_routing_manifest(
                manifest_paths,
                source_path,
                processing_profile,
                failed_routes,
                **manifest_kwargs,
            )
            raise

        markdown = _markdown_document(page_texts, fallback_texts)
        output_path = cache_dir / "upload.md"
        await asyncio.to_thread(_write_text_atomic, output_path, markdown)
        return PreparedUpload(
            output_path,
            _fallback_upload_name(upload_name),
            fallback_page_numbers,
            tuple(page_routes),
        )

    async def _prepare_image(
        self,
        source_path: Path,
        processing_profile: ProcessingProfile,
        upload_name: str,
        page_routing_manifest_path: Path | None,
    ) -> PreparedUpload:
        cache_dir = await asyncio.to_thread(self._cache_dir, source_path)
        media_type = _IMAGE_MEDIA_TYPES[source_path.suffix.lower()]
        page_routes = [
            PageRoute(
                page=1,
                route="full_page_vlm",
                reason="image_input",
                canonical_source="vlm_transcription",
                native_text_chars=0,
                control_character_ratio=0,
                status="pending",
            )
        ]
        manifest_paths = (cache_dir / "manifest.json",)
        if page_routing_manifest_path is not None:
            manifest_paths = (page_routing_manifest_path, *manifest_paths)
        await self._write_page_routing_manifest(
            manifest_paths, source_path, processing_profile, page_routes
        )
        try:
            async with self._vision_client() as client:
                page_routes[0] = replace(page_routes[0], status="processing")
                await self._write_page_routing_manifest(
                    manifest_paths, source_path, processing_profile, page_routes
                )
                transcription, cache_hit = await self._transcribe_cached_image(
                    client, source_path, media_type, cache_dir
                )
        except VisualFallbackError as exc:
            page_routes[0] = replace(
                page_routes[0], status="failed", error=str(exc)[:500]
            )
            await self._write_page_routing_manifest(
                manifest_paths, source_path, processing_profile, page_routes
            )
            raise
        page_routes[0] = replace(
            page_routes[0],
            status="cached" if cache_hit else "completed",
            vlm_cache_hit=cache_hit,
        )
        await self._write_page_routing_manifest(
            manifest_paths, source_path, processing_profile, page_routes
        )
        markdown = _markdown_document([""], {0: transcription})
        output_path = cache_dir / "upload.md"
        await asyncio.to_thread(_write_text_atomic, output_path, markdown)
        return PreparedUpload(
            output_path,
            _fallback_upload_name(upload_name),
            (1,),
            tuple(page_routes),
        )

    async def _write_page_routing_manifest(
        self,
        paths: tuple[Path, ...],
        source_path: Path,
        processing_profile: ProcessingProfile,
        page_routes: list[PageRoute],
        *,
        source_file: str | None = None,
        source_kind: str = "pdf",
        rendered_file: str | None = None,
        conversion: dict[str, str] | None = None,
    ) -> None:
        if not paths:
            return
        payload = _page_routing_manifest(
            source_path,
            processing_profile,
            page_routes,
            source_file=source_file,
            source_kind=source_kind,
            rendered_file=rendered_file,
            conversion=conversion,
        )
        await asyncio.to_thread(_write_json_to_paths_atomic, paths, payload)

    def _office_cache_dir(self, source_path: Path) -> Path:
        source_hash = _sha256_file(source_path)
        cache_dir = self._settings.cache_root / "office_conversion" / source_hash
        cache_dir.mkdir(parents=True, exist_ok=True)
        return cache_dir

    def _convert_office_document(self, source_path: Path) -> Path:
        cache_dir = self._office_cache_dir(source_path)
        output_path = cache_dir / f"{source_path.stem}.pdf"
        if output_path.is_file() and output_path.stat().st_size > 0:
            return output_path

        temporary_output = Path(
            tempfile.mkdtemp(prefix="office-output-", dir=cache_dir)
        )
        temporary_profile = Path(
            tempfile.mkdtemp(prefix="office-profile-", dir=cache_dir)
        )
        try:
            command = [
                self._settings.office_converter,
                f"-env:UserInstallation={temporary_profile.as_uri()}",
                "--headless",
                "--convert-to",
                "pdf",
                "--outdir",
                str(temporary_output),
                str(source_path),
            ]
            try:
                result = subprocess.run(
                    command,
                    capture_output=True,
                    text=True,
                    timeout=self._settings.office_conversion_timeout_seconds,
                    check=False,
                )
            except FileNotFoundError as exc:
                raise VisualFallbackError(
                    "Office conversion requires LibreOffice; install soffice or "
                    "set RAG_OFFICE_CONVERTER"
                ) from exc
            except subprocess.TimeoutExpired as exc:
                raise VisualFallbackError(
                    "Office to PDF conversion timed out after "
                    f"{self._settings.office_conversion_timeout_seconds} seconds"
                ) from exc

            if result.returncode != 0:
                detail = (result.stderr or result.stdout or "conversion failed").strip()
                raise VisualFallbackError(
                    f"Office to PDF conversion failed for {source_path.name}: {detail[:500]}"
                )
            candidates = list(temporary_output.glob("*.pdf"))
            if not candidates:
                raise VisualFallbackError(
                    f"Office converter produced no PDF for {source_path.name}"
                )
            converted_path = next(
                (candidate for candidate in candidates if candidate.name == output_path.name),
                candidates[0],
            )
            os.replace(converted_path, output_path)
            return output_path
        finally:
            shutil.rmtree(temporary_output, ignore_errors=True)
            shutil.rmtree(temporary_profile, ignore_errors=True)

    def _cache_dir(self, source_path: Path) -> Path:
        source_hash = _sha256_file(source_path)
        fingerprint = hashlib.sha256(
            json.dumps(
                {
                    "base_url": self._settings.base_url,
                    "max_tokens": self._settings.max_tokens,
                    "min_text_chars": self._settings.min_text_chars,
                    "model": self._settings.model,
                    "prompt_version": _PROMPT_VERSION,
                    "render_dpi": self._settings.render_dpi,
                },
                ensure_ascii=True,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        cache_dir = self._settings.cache_root / source_hash / fingerprint
        cache_dir.mkdir(parents=True, exist_ok=True)
        return cache_dir

    def _vision_client(self) -> httpx.AsyncClient:
        if not self._settings.base_url:
            raise VisualFallbackError(
                "VLM endpoint is not configured; set VLM_LLM_BINDING_HOST or "
                "RAG_VISUAL_FALLBACK_VLM_BASE_URL"
            )
        if not self._settings.api_key:
            raise VisualFallbackError(
                "VLM API key is not configured; set VLM_LLM_BINDING_API_KEY or "
                "RAG_VISUAL_FALLBACK_VLM_API_KEY"
            )
        if not self._settings.model or self._settings.model == "replace-with-vision-model":
            raise VisualFallbackError(
                "VLM model is not configured; set VLM_LLM_MODEL or "
                "RAG_VISUAL_FALLBACK_VLM_MODEL"
            )
        return httpx.AsyncClient(
            timeout=httpx.Timeout(self._settings.request_timeout_seconds),
            headers={"Authorization": f"Bearer {self._settings.api_key}"},
            follow_redirects=False,
        )

    async def _transcribe_pdf_page(
        self,
        client: httpx.AsyncClient,
        source_path: Path,
        page_index: int,
        cache_dir: Path,
    ) -> tuple[str, bool]:
        page_path = cache_dir / "pages" / f"page-{page_index + 1:04d}.md"
        cached = await asyncio.to_thread(_read_cached_text, page_path)
        if cached is not None:
            return cached, True
        image_bytes = await asyncio.to_thread(
            _render_pdf_page, source_path, page_index, self._settings.render_dpi
        )
        transcription = await self._call_vlm(client, image_bytes, "image/png")
        await asyncio.to_thread(_write_text_atomic, page_path, transcription)
        return transcription, False

    async def _transcribe_cached_image(
        self,
        client: httpx.AsyncClient,
        source_path: Path,
        media_type: str,
        cache_dir: Path,
    ) -> tuple[str, bool]:
        page_path = cache_dir / "pages" / "page-0001.md"
        cached = await asyncio.to_thread(_read_cached_text, page_path)
        if cached is not None:
            return cached, True
        image_bytes = await asyncio.to_thread(source_path.read_bytes)
        transcription = await self._call_vlm(client, image_bytes, media_type)
        await asyncio.to_thread(_write_text_atomic, page_path, transcription)
        return transcription, False

    async def _call_vlm(
        self, client: httpx.AsyncClient, image_bytes: bytes, media_type: str
    ) -> str:
        assert self._settings.base_url is not None
        assert self._settings.model is not None
        encoded_image = base64.b64encode(image_bytes).decode("ascii")
        payload = {
            "model": self._settings.model,
            "temperature": 0,
            "max_tokens": self._settings.max_tokens,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are a document transcription engine. Return only the "
                        "verbatim page transcription in Markdown."
                    ),
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": (
                                "Transcribe every visible piece of text on this page. "
                                "Preserve names, IDs, dates, labels, Chinese characters, "
                                "English text, and numbers exactly. Do not summarize, "
                                "translate, omit text, or infer missing text. Use "
                                "[illegible] only for characters that cannot be read."
                            ),
                        },
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:{media_type};base64,{encoded_image}",
                                "detail": "high",
                            },
                        },
                    ],
                },
            ],
        }
        endpoint = _chat_completions_url(self._settings.base_url)
        try:
            response = await client.post(endpoint, json=payload)
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            detail = _http_error_detail(exc.response)
            raise VisualFallbackError(
                f"VLM transcription request returned HTTP {exc.response.status_code}: {detail}"
            ) from exc
        except httpx.RequestError as exc:
            raise VisualFallbackError(
                f"VLM transcription request failed: {exc.__class__.__name__}"
            ) from exc
        try:
            response_payload = response.json()
        except ValueError as exc:
            raise VisualFallbackError("VLM transcription returned invalid JSON") from exc
        transcription = _response_text(response_payload)
        if not transcription:
            raise VisualFallbackError("VLM transcription returned an empty response")
        return transcription


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


def _env_text(name: str, default: str) -> str:
    value = os.getenv(name, default).strip()
    if not value:
        raise ValueError(f"{name} cannot be empty")
    return value


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw_value = os.getenv(name, str(default))
    try:
        value = int(raw_value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


def _env_path(name: str, default: Path) -> Path:
    raw_value = os.getenv(name, str(default)).strip()
    if not raw_value:
        raise ValueError(f"{name} cannot be empty")
    return Path(raw_value).expanduser().resolve()


def _first_env(*names: str) -> str | None:
    for name in names:
        value = os.getenv(name)
        if value and value.strip():
            return value.strip()
    return None


def _extract_pdf_texts(source_path: Path) -> list[str]:
    try:
        reader = PdfReader(str(source_path))
    except Exception as exc:
        raise VisualFallbackError(f"Cannot read PDF for visual text fallback: {exc}") from exc
    if reader.is_encrypted:
        raise VisualFallbackError("Cannot transcribe an encrypted PDF")
    texts: list[str] = []
    for page in reader.pages:
        try:
            texts.append(page.extract_text() or "")
        except Exception:
            texts.append("")
    if not texts:
        raise VisualFallbackError("PDF contains no pages")
    return texts


def _render_pdf_page(source_path: Path, page_index: int, dpi: int) -> bytes:
    try:
        import fitz
    except ImportError as exc:
        raise VisualFallbackError(
            "PyMuPDF is unavailable; rebuild the RAG image after updating requirements"
        ) from exc
    try:
        document = fitz.open(source_path)
        try:
            page = document.load_page(page_index)
            scale = dpi / 72
            pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
            return pixmap.tobytes("png")
        finally:
            document.close()
    except Exception as exc:
        raise VisualFallbackError(
            f"Cannot render PDF page {page_index + 1} for visual transcription: {exc}"
        ) from exc


def _normalized_text(value: str) -> str:
    return "".join(value.split())


def _text_quality(value: str) -> tuple[int, float]:
    normalized = _normalized_text(value)
    control_count = sum(
        ord(character) < 32 or 127 <= ord(character) <= 159
        for character in normalized
    )
    control_ratio = control_count / len(normalized) if normalized else 0
    return len(normalized), control_ratio


def _pdf_page_route(
    page: int,
    value: str,
    processing_profile: ProcessingProfile,
    *,
    enabled: bool,
    min_text_chars: int,
) -> PageRoute:
    native_text_chars, control_character_ratio = _text_quality(value)
    reason = "native_text_available"
    should_transcribe = False
    if not enabled:
        reason = "visual_fallback_disabled"
    elif processing_profile == "full":
        reason = "full_profile"
        should_transcribe = True
    elif native_text_chars < min_text_chars:
        reason = "low_native_text"
        should_transcribe = True
    elif control_character_ratio > _MAX_CONTROL_CHARACTER_RATIO:
        reason = "unreliable_pdf_text"
        should_transcribe = True

    if should_transcribe:
        return PageRoute(
            page=page,
            route="full_page_vlm",
            reason=reason,
            canonical_source="vlm_transcription",
            native_text_chars=native_text_chars,
            control_character_ratio=round(control_character_ratio, 6),
            status="pending",
        )
    return PageRoute(
        page=page,
        route="native_pdf_text",
        reason=reason,
        canonical_source="embedded_pdf_text",
        native_text_chars=native_text_chars,
        control_character_ratio=round(control_character_ratio, 6),
        status="ready",
    )


def _page_routing_manifest(
    source_path: Path,
    processing_profile: ProcessingProfile,
    page_routes: list[PageRoute],
    *,
    source_file: str | None = None,
    source_kind: str = "pdf",
    rendered_file: str | None = None,
    conversion: dict[str, str] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "prompt_version": _PROMPT_VERSION,
        "source_file": source_file or source_path.name,
        "source_kind": source_kind,
        "rendered_file": rendered_file,
        "conversion": conversion,
        "processing_profile": processing_profile,
        "page_count": len(page_routes),
        "fallback_pages": [
            route.page for route in page_routes if route.route == "full_page_vlm"
        ],
        "pages": [asdict(route) for route in page_routes],
    }


def _markdown_document(page_texts: list[str], fallback_texts: dict[int, str]) -> str:
    pages: list[str] = []
    for index, extracted_text in enumerate(page_texts):
        content = fallback_texts.get(index, extracted_text).strip()
        if not content:
            content = "[No readable text found]"
        pages.append(f"[Source page: {index + 1}]\n\n## Page {index + 1}\n\n{content}")
    return "\n\n---\n\n".join(pages) + "\n"


def _fallback_upload_name(upload_name: str) -> str:
    source_name = Path(upload_name).name
    return f"{Path(source_name).stem}.visual-fallback.md"


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _read_cached_text(path: Path) -> str | None:
    if not path.is_file():
        return None
    content = path.read_text(encoding="utf-8").strip()
    return content or None


def _write_text_atomic(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_suffix(path.suffix + ".tmp")
    temporary_path.write_text(content, encoding="utf-8")
    temporary_path.replace(path)


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    _write_text_atomic(path, json.dumps(payload, ensure_ascii=True, indent=2) + "\n")


def _write_json_to_paths_atomic(paths: tuple[Path, ...], payload: dict[str, Any]) -> None:
    for path in dict.fromkeys(paths):
        _write_json_atomic(path, payload)


def _chat_completions_url(base_url: str) -> str:
    normalized = base_url.rstrip("/")
    return normalized if normalized.endswith("/chat/completions") else f"{normalized}/chat/completions"


def _http_error_detail(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return (response.text or response.reason_phrase)[:500]
    if isinstance(body, dict):
        detail = body.get("error") or body.get("message") or body.get("detail") or body
        if isinstance(detail, dict):
            detail = detail.get("message") or detail
        return str(detail)[:500]
    return str(body)[:500]


def _response_text(payload: Any) -> str:
    if not isinstance(payload, dict):
        raise VisualFallbackError("VLM transcription response must be a JSON object")
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        raise VisualFallbackError("VLM transcription response does not contain choices")
    first_choice = choices[0]
    if not isinstance(first_choice, dict):
        raise VisualFallbackError("VLM transcription choice is invalid")
    message = first_choice.get("message")
    if not isinstance(message, dict):
        raise VisualFallbackError("VLM transcription response does not contain a message")
    content = message.get("content")
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        text_parts = [
            item.get("text", "").strip()
            for item in content
            if isinstance(item, dict) and isinstance(item.get("text"), str)
        ]
        return "\n".join(part for part in text_parts if part)
    raise VisualFallbackError("VLM transcription message content is invalid")
