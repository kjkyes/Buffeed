from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import re
from dataclasses import dataclass, replace
from pathlib import Path

import asyncpg
import rag_config  # noqa: F401 - load the active profile before settings imports
from rag_database import PostgresSettings, create_postgres_pool
from rag_observability import configure_logging, log_event


_MIGRATION_NAME = re.compile(r"^(?P<version>\d{3})-(?P<name>[a-z0-9][a-z0-9-]*)\.sql$")
_LOCK_NAME = "rag-schema-migrations"

logger = configure_logging("rag_migrate")


@dataclass(frozen=True)
class Migration:
    version: str
    name: str
    path: Path
    checksum: str


def discover_migrations(directory: Path) -> list[Migration]:
    migrations: list[Migration] = []
    for path in sorted(directory.glob("*.sql")):
        match = _MIGRATION_NAME.fullmatch(path.name)
        if match is None:
            raise RuntimeError(f"Invalid migration file name: {path.name}")
        migrations.append(
            Migration(
                version=match.group("version"),
                name=match.group("name"),
                path=path,
                checksum=hashlib.sha256(path.read_bytes()).hexdigest(),
            )
        )
    if not migrations:
        raise RuntimeError(f"No migrations found in {directory}")
    versions = [migration.version for migration in migrations]
    if len(versions) != len(set(versions)):
        raise RuntimeError("Migration versions must be unique")
    return migrations


async def _load_applied(connection: asyncpg.Connection) -> dict[str, str]:
    table_exists = await connection.fetchval(
        "SELECT to_regclass('public.rag_schema_migrations') IS NOT NULL"
    )
    if not table_exists:
        return {}
    rows = await connection.fetch(
        "SELECT version, checksum FROM public.rag_schema_migrations ORDER BY version"
    )
    return {row["version"]: row["checksum"] for row in rows}


async def _ensure_migration_table(connection: asyncpg.Connection) -> None:
    await connection.execute(
        """
        CREATE TABLE IF NOT EXISTS public.rag_schema_migrations (
            version TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            checksum TEXT NOT NULL,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )


def _migration_report(
    migrations: list[Migration], applied: dict[str, str]
) -> tuple[list[str], list[str]]:
    pending: list[str] = []
    verified: list[str] = []
    for migration in migrations:
        recorded_checksum = applied.get(migration.version)
        if recorded_checksum is None:
            pending.append(migration.path.name)
        elif recorded_checksum != migration.checksum:
            raise RuntimeError(
                f"Migration checksum mismatch for {migration.path.name}; "
                "do not edit a migration that has already been applied"
            )
        else:
            verified.append(migration.path.name)
    return pending, verified


async def run_migrations(*, check_only: bool) -> dict[str, object]:
    migration_directory = Path(__file__).with_name("postgres-init")
    migrations = discover_migrations(migration_directory)
    database_settings = replace(
        PostgresSettings.from_env(), application_name="rag-migrate"
    )
    pool = await create_postgres_pool(database_settings)
    try:
        async with pool.acquire() as connection:
            if check_only:
                applied = await _load_applied(connection)
                pending, verified = _migration_report(migrations, applied)
                return {
                    "mode": "check",
                    "verified": verified,
                    "pending": pending,
                }

            await connection.execute(
                "SELECT pg_advisory_lock(hashtext($1::text))", _LOCK_NAME
            )
            try:
                await _ensure_migration_table(connection)
                applied = await _load_applied(connection)
                pending, verified = _migration_report(migrations, applied)
                applied_now: list[str] = []
                for migration in migrations:
                    if migration.path.name not in pending:
                        continue
                    async with connection.transaction():
                        await connection.execute(migration.path.read_text(encoding="utf-8"))
                        await connection.execute(
                            """
                            INSERT INTO public.rag_schema_migrations (
                                version, name, checksum
                            )
                            VALUES ($1, $2, $3)
                            """,
                            migration.version,
                            migration.name,
                            migration.checksum,
                        )
                    applied_now.append(migration.path.name)
                return {
                    "mode": "apply",
                    "verified": verified,
                    "applied": applied_now,
                }
            finally:
                await connection.execute(
                    "SELECT pg_advisory_unlock(hashtext($1::text))", _LOCK_NAME
                )
    finally:
        await pool.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Apply verified RAG PostgreSQL migrations in order."
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Check migration checksums and report pending files without applying them.",
    )
    arguments = parser.parse_args()
    result = asyncio.run(run_migrations(check_only=arguments.check))
    log_event(
        logger,
        "rag_migrations_completed",
        mode=result["mode"],
        applied=result.get("applied", []),
        pending=result.get("pending", []),
    )
    print(json.dumps(result, indent=2))
