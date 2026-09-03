-- P4: durable worker queue, leases, retry timing, and task audit history.
-- Run after 001-rag-schema.sql through 003-hybrid-retrieval.sql.

ALTER TABLE rag.documents
    ADD COLUMN IF NOT EXISTS delete_requested_at TIMESTAMPTZ;

ALTER TABLE rag.ingest_tasks
    ADD COLUMN IF NOT EXISTS task_type TEXT,
    ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS lightrag_track_id TEXT,
    ADD COLUMN IF NOT EXISTS parent_task_id UUID,
    ADD COLUMN IF NOT EXISTS lease_owner TEXT,
    ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS vector_ready_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS graph_ready_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE rag.ingest_tasks
SET task_type = 'ingest'
WHERE task_type IS NULL;

ALTER TABLE rag.ingest_tasks
    ALTER COLUMN task_type SET DEFAULT 'ingest',
    ALTER COLUMN task_type SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'ingest_tasks_task_type_check'
    ) THEN
        ALTER TABLE rag.ingest_tasks
            ADD CONSTRAINT ingest_tasks_task_type_check
            CHECK (task_type IN ('ingest', 'rebuild', 'graph', 'delete'));
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'ingest_tasks_parent_task_id_fkey'
    ) THEN
        ALTER TABLE rag.ingest_tasks
            ADD CONSTRAINT ingest_tasks_parent_task_id_fkey
            FOREIGN KEY (parent_task_id)
            REFERENCES rag.ingest_tasks(task_id)
            ON DELETE RESTRICT;
    END IF;
END $$;

-- Completed document revisions are removed during a unified delete. Tasks must
-- remain as audit records after that cleanup, so they intentionally do not keep
-- a cascading foreign key to rag.document_revisions.
DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    FOR constraint_name IN
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'rag.ingest_tasks'::regclass
          AND contype = 'f'
          AND confrelid = 'rag.document_revisions'::regclass
    LOOP
        EXECUTE format(
            'ALTER TABLE rag.ingest_tasks DROP CONSTRAINT %I', constraint_name
        );
    END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS rag.ingest_task_events (
    event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    task_id UUID NOT NULL REFERENCES rag.ingest_tasks(task_id) ON DELETE RESTRICT,
    from_status TEXT,
    to_status TEXT NOT NULL,
    detail TEXT,
    worker_id TEXT,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ingest_tasks_parent_task_type_idx
    ON rag.ingest_tasks (parent_task_id, task_type)
    WHERE parent_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ingest_tasks_ready_idx
    ON rag.ingest_tasks (status, next_attempt_at, requested_at, task_id)
    WHERE status IN ('queued', 'kg_pending', 'kg_running');
CREATE INDEX IF NOT EXISTS ingest_tasks_lease_idx
    ON rag.ingest_tasks (lease_expires_at)
    WHERE lease_expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS ingest_tasks_document_revision_idx
    ON rag.ingest_tasks (document_id, revision, requested_at DESC);
CREATE INDEX IF NOT EXISTS ingest_task_events_task_occurred_idx
    ON rag.ingest_task_events (task_id, occurred_at, event_id);
CREATE INDEX IF NOT EXISTS documents_delete_requested_idx
    ON rag.documents (delete_requested_at)
    WHERE delete_requested_at IS NOT NULL;
