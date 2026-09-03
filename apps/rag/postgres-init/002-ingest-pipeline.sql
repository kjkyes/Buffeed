-- P2: parser isolation, parent/child chunks, and revision-aware ingestion.
-- This migration is safe to run after 001-rag-schema.sql on an external
-- PostgreSQL instance. It contains no Docker-specific assumptions.

ALTER TABLE rag.document_revisions
    DROP CONSTRAINT IF EXISTS document_revisions_document_id_content_sha256_key;

ALTER TABLE rag.chunks
    ADD COLUMN IF NOT EXISTS chunk_kind TEXT NOT NULL DEFAULT 'child',
    ADD COLUMN IF NOT EXISTS parent_chunk_id UUID,
    ADD COLUMN IF NOT EXISTS content TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS source_page INTEGER,
    ADD COLUMN IF NOT EXISTS source_block_id TEXT,
    ADD COLUMN IF NOT EXISTS source_uri TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chunks_chunk_kind_check'
    ) THEN
        ALTER TABLE rag.chunks
            ADD CONSTRAINT chunks_chunk_kind_check
            CHECK (chunk_kind IN ('parent', 'child'));
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chunks_source_page_check'
    ) THEN
        ALTER TABLE rag.chunks
            ADD CONSTRAINT chunks_source_page_check
            CHECK (source_page IS NULL OR source_page >= 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chunks_parent_chunk_id_fkey'
    ) THEN
        ALTER TABLE rag.chunks
            ADD CONSTRAINT chunks_parent_chunk_id_fkey
            FOREIGN KEY (parent_chunk_id)
            REFERENCES rag.chunks(chunk_id)
            ON DELETE CASCADE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS chunks_parent_chunk_id_idx
    ON rag.chunks (parent_chunk_id)
    WHERE parent_chunk_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS chunks_source_page_idx
    ON rag.chunks (document_id, revision, source_page)
    WHERE source_page IS NOT NULL;

CREATE TABLE IF NOT EXISTS rag.parser_runs (
    parser_run_id UUID PRIMARY KEY,
    document_id UUID NOT NULL,
    revision INTEGER NOT NULL,
    parser_name TEXT NOT NULL,
    parser_version TEXT,
    workspace TEXT NOT NULL,
    artifact_namespace TEXT NOT NULL,
    artifact_uri TEXT,
    status TEXT NOT NULL CHECK (status IN (
        'queued', 'running', 'completed', 'failed', 'cancelled'
    )),
    error_detail TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    FOREIGN KEY (document_id, revision)
        REFERENCES rag.document_revisions(document_id, revision)
        ON DELETE CASCADE,
    UNIQUE (document_id, revision, parser_name, workspace)
);

CREATE INDEX IF NOT EXISTS parser_runs_document_revision_idx
    ON rag.parser_runs (document_id, revision);
CREATE INDEX IF NOT EXISTS parser_runs_status_created_at_idx
    ON rag.parser_runs (status, created_at);

UPDATE rag.ingest_tasks
SET status = 'queued'
WHERE status = 'processing';

ALTER TABLE rag.ingest_tasks
    DROP CONSTRAINT IF EXISTS ingest_tasks_status_check;
ALTER TABLE rag.ingest_tasks
    ADD CONSTRAINT ingest_tasks_status_check CHECK (status IN (
        'queued', 'vector_ready', 'kg_pending', 'kg_running',
        'graph_ready', 'failed', 'cancelled'
    ));
