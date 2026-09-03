from __future__ import annotations

import os
import ssl
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import asyncpg


SslMode = Literal["disable", "require", "verify-ca", "verify-full"]


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw_value = os.getenv(name, str(default))
    try:
        value = int(raw_value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


@dataclass(frozen=True)
class PostgresSettings:
    host: str
    port: int
    user: str
    password: str
    database: str
    ssl_mode: SslMode
    ssl_ca_file: Path | None
    connect_timeout_seconds: int
    min_pool_size: int
    max_pool_size: int
    application_name: str = "rag-registry"

    @classmethod
    def from_env(cls) -> "PostgresSettings":
        host = os.getenv("POSTGRES_HOST", "").strip()
        user = os.getenv("POSTGRES_USER", "").strip()
        password = os.getenv("POSTGRES_PASSWORD", "")
        database = os.getenv("POSTGRES_DATABASE", "").strip()
        if not host:
            raise ValueError("POSTGRES_HOST must be configured")
        if not user:
            raise ValueError("POSTGRES_USER must be configured")
        if not password:
            raise ValueError("POSTGRES_PASSWORD must be configured")
        if not database:
            raise ValueError("POSTGRES_DATABASE must be configured")

        raw_ssl_mode = os.getenv("POSTGRES_SSL_MODE", "require").strip().lower()
        if raw_ssl_mode not in {"disable", "require", "verify-ca", "verify-full"}:
            raise ValueError(
                "POSTGRES_SSL_MODE must be disable, require, verify-ca, or verify-full"
            )

        raw_ca_file = (
            os.getenv("POSTGRES_SSL_CA_FILE", "").strip()
            or os.getenv("POSTGRES_SSL_ROOT_CERT", "").strip()
        )
        ssl_ca_file = Path(raw_ca_file).expanduser().resolve() if raw_ca_file else None
        if ssl_ca_file is not None and not ssl_ca_file.is_file():
            raise ValueError("POSTGRES_SSL_CA_FILE must point to an existing file")

        min_pool_size = _env_int("POSTGRES_POOL_MIN_SIZE", 1, 0, 64)
        max_pool_size = _env_int("POSTGRES_POOL_MAX_SIZE", 5, 1, 64)
        if min_pool_size > max_pool_size:
            raise ValueError("POSTGRES_POOL_MIN_SIZE cannot exceed POSTGRES_POOL_MAX_SIZE")

        return cls(
            host=host,
            port=_env_int("POSTGRES_PORT", 5432, 1, 65535),
            user=user,
            password=password,
            database=database,
            ssl_mode=raw_ssl_mode,
            ssl_ca_file=ssl_ca_file,
            connect_timeout_seconds=_env_int(
                "POSTGRES_CONNECT_TIMEOUT_SECONDS", 15, 1, 300
            ),
            min_pool_size=min_pool_size,
            max_pool_size=max_pool_size,
            application_name=os.getenv("POSTGRES_APPLICATION_NAME", "rag-registry"),
        )

    def ssl_context(self) -> ssl.SSLContext | bool:
        if self.ssl_mode == "disable":
            return False

        context = ssl.create_default_context(
            cafile=str(self.ssl_ca_file) if self.ssl_ca_file else None
        )
        if self.ssl_mode == "require":
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
        elif self.ssl_mode == "verify-ca":
            context.check_hostname = False
        return context


async def create_postgres_pool(settings: PostgresSettings) -> asyncpg.Pool:
    return await asyncpg.create_pool(
        host=settings.host,
        port=settings.port,
        user=settings.user,
        password=settings.password,
        database=settings.database,
        ssl=settings.ssl_context(),
        min_size=settings.min_pool_size,
        max_size=settings.max_pool_size,
        timeout=settings.connect_timeout_seconds,
        command_timeout=settings.connect_timeout_seconds,
        server_settings={"application_name": settings.application_name},
    )


async def probe_postgres() -> dict[str, Any]:
    """Check database connectivity without returning credentials or endpoints."""
    try:
        settings = PostgresSettings.from_env()
    except (OSError, ValueError) as exc:
        return {
            "configured": False,
            "reachable": False,
            "ssl_mode": None,
            "error": exc.__class__.__name__,
        }

    connection: asyncpg.Connection | None = None
    try:
        connection = await asyncpg.connect(
            host=settings.host,
            port=settings.port,
            user=settings.user,
            password=settings.password,
            database=settings.database,
            ssl=settings.ssl_context(),
            timeout=settings.connect_timeout_seconds,
            command_timeout=settings.connect_timeout_seconds,
            server_settings={"application_name": f"{settings.application_name}-health"},
        )
        await connection.fetchval("SELECT 1")
        return {
            "configured": True,
            "reachable": True,
            "ssl_mode": settings.ssl_mode,
        }
    except Exception as exc:
        return {
            "configured": True,
            "reachable": False,
            "ssl_mode": settings.ssl_mode,
            "error": exc.__class__.__name__,
        }
    finally:
        if connection is not None:
            await connection.close()
