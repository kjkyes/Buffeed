from __future__ import annotations

import argparse
import json
import tarfile
from datetime import datetime, timezone
from pathlib import Path

from rag_observability import configure_logging, log_event


logger = configure_logging("rag_backup")


def _add_directory(archive: tarfile.TarFile, source: Path, archive_root: str) -> None:
    if not source.is_dir():
        raise RuntimeError(f"Backup source is not a directory: {source}")
    archive.add(source, arcname=archive_root, recursive=False)
    for path in sorted(source.rglob("*")):
        if path.is_symlink():
            continue
        archive.add(
            path,
            arcname=(Path(archive_root) / path.relative_to(source)).as_posix(),
            recursive=False,
        )


def create_backup(
    *, output_dir: Path, lightrag_working_dir: Path, artifact_dir: Path
) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    archive_path = output_dir / f"rag-artifacts-{timestamp}.tar.gz"
    with tarfile.open(archive_path, "w:gz", dereference=False) as archive:
        _add_directory(archive, lightrag_working_dir, "lightrag-working")
        _add_directory(archive, artifact_dir, "rag-artifacts")
    return archive_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Archive only the LightRAG working volume and RAG artifact volume."
    )
    parser.add_argument("--output-dir", type=Path, default=Path("/backups"))
    parser.add_argument(
        "--lightrag-working-dir", type=Path, default=Path("/srv/rag/lightrag")
    )
    parser.add_argument("--artifact-dir", type=Path, default=Path("/srv/rag/artifacts"))
    arguments = parser.parse_args()
    archive = create_backup(
        output_dir=arguments.output_dir,
        lightrag_working_dir=arguments.lightrag_working_dir,
        artifact_dir=arguments.artifact_dir,
    )
    log_event(logger, "rag_artifact_backup_completed", archive=str(archive))
    print(
        json.dumps(
            {
                "status": "success",
                "archive": str(archive),
                "database_backup": "Use Alibaba Cloud managed PostgreSQL backup separately.",
            }
        )
    )
