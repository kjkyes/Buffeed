from __future__ import annotations

import contextlib
import contextvars
import json
import logging
import math
import os
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterator
from uuid import uuid4


_REQUEST_ID = contextvars.ContextVar[str | None]("rag_request_id", default=None)
_MAX_REQUEST_ID_LENGTH = 128


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw_value = os.getenv(name, str(default))
    try:
        value = int(raw_value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


def normalize_request_id(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    if not normalized:
        return None
    if len(normalized) > _MAX_REQUEST_ID_LENGTH:
        raise ValueError("request_id is too long")
    if any(character.isspace() or ord(character) < 32 for character in normalized):
        raise ValueError("request_id contains invalid characters")
    return normalized


def new_request_id() -> str:
    return uuid4().hex


def get_request_id() -> str | None:
    return _REQUEST_ID.get()


@contextlib.contextmanager
def request_context(request_id: str | None = None) -> Iterator[str]:
    normalized = normalize_request_id(request_id) or new_request_id()
    token = _REQUEST_ID.set(normalized)
    try:
        yield normalized
    finally:
        _REQUEST_ID.reset(token)


@dataclass
class _ToolMetric:
    count: int = 0
    errors: int = 0
    duration_total_ms: float = 0.0
    duration_min_ms: float | None = None
    duration_max_ms: float | None = None
    samples: deque[float] = field(default_factory=deque)


class MetricStore:
    """Bounded in-process metrics for MCP request telemetry."""

    def __init__(self, sample_size: int | None = None) -> None:
        self._sample_size = sample_size or _env_int(
            "RAG_METRICS_SAMPLE_SIZE", 512, 16, 10000
        )
        self._created_at = datetime.now(timezone.utc)
        self._lock = threading.Lock()
        self._tools: dict[str, _ToolMetric] = {}

    def observe(self, tool_name: str, duration_ms: float, *, failed: bool) -> None:
        with self._lock:
            metric = self._tools.get(tool_name)
            if metric is None:
                metric = _ToolMetric(samples=deque(maxlen=self._sample_size))
                self._tools[tool_name] = metric
            metric.count += 1
            metric.errors += int(failed)
            metric.duration_total_ms += duration_ms
            metric.duration_min_ms = (
                duration_ms
                if metric.duration_min_ms is None
                else min(metric.duration_min_ms, duration_ms)
            )
            metric.duration_max_ms = (
                duration_ms
                if metric.duration_max_ms is None
                else max(metric.duration_max_ms, duration_ms)
            )
            metric.samples.append(duration_ms)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            tools = {
                tool_name: _metric_snapshot(metric)
                for tool_name, metric in sorted(self._tools.items())
            }
        return {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "started_at": self._created_at.isoformat(),
            "sample_size": self._sample_size,
            "tools": tools,
        }


def _metric_snapshot(metric: _ToolMetric) -> dict[str, Any]:
    samples = sorted(metric.samples)
    return {
        "requests_total": metric.count,
        "errors_total": metric.errors,
        "duration_ms": {
            "avg": round(metric.duration_total_ms / metric.count, 3)
            if metric.count
            else 0.0,
            "min": round(metric.duration_min_ms or 0.0, 3),
            "max": round(metric.duration_max_ms or 0.0, 3),
            "p50": round(_percentile(samples, 0.50), 3),
            "p95": round(_percentile(samples, 0.95), 3),
            "sample_count": len(samples),
        },
    }


def _percentile(samples: list[float], percentile: float) -> float:
    if not samples:
        return 0.0
    index = max(0, math.ceil(len(samples) * percentile) - 1)
    return samples[index]


class JsonFormatter(logging.Formatter):
    def __init__(self, service: str) -> None:
        super().__init__()
        self._service = service

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "service": self._service,
            "event": record.getMessage(),
        }
        request_id = get_request_id()
        if request_id:
            payload["request_id"] = request_id
        fields = getattr(record, "rag_fields", None)
        if isinstance(fields, dict):
            payload.update(_json_safe_fields(fields))
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=str)


def _json_safe_fields(fields: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in fields.items()
        if isinstance(key, str) and key not in {"timestamp", "level", "service", "event"}
    }


def configure_logging(service: str, level: str | None = None) -> logging.Logger:
    logger = logging.getLogger(service)
    logger.setLevel((level or os.getenv("RAG_LOG_LEVEL", "INFO")).upper())
    logger.propagate = False
    if not any(getattr(handler, "_rag_json", False) for handler in logger.handlers):
        handler = logging.StreamHandler()
        handler.setFormatter(JsonFormatter(service))
        handler._rag_json = True  # type: ignore[attr-defined]
        logger.addHandler(handler)
    return logger


def log_event(logger: logging.Logger, event: str, **fields: Any) -> None:
    logger.info(event, extra={"rag_fields": fields})


metrics = MetricStore()


def elapsed_ms(started_at: float) -> float:
    return (time.perf_counter() - started_at) * 1000
