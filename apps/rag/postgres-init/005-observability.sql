-- P5: retain request correlation IDs for task and event audit trails.

ALTER TABLE rag.ingest_tasks
    ADD COLUMN IF NOT EXISTS request_id TEXT;

ALTER TABLE rag.ingest_task_events
    ADD COLUMN IF NOT EXISTS request_id TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'rag.ingest_tasks'::regclass
          AND conname = 'ingest_tasks_request_id_length_check'
    ) THEN
        ALTER TABLE rag.ingest_tasks
            ADD CONSTRAINT ingest_tasks_request_id_length_check
            CHECK (request_id IS NULL OR char_length(request_id) <= 128);
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'rag.ingest_task_events'::regclass
          AND conname = 'ingest_task_events_request_id_length_check'
    ) THEN
        ALTER TABLE rag.ingest_task_events
            ADD CONSTRAINT ingest_task_events_request_id_length_check
            CHECK (request_id IS NULL OR char_length(request_id) <= 128);
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS ingest_tasks_request_id_idx
    ON rag.ingest_tasks (request_id)
    WHERE request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ingest_task_events_request_id_idx
    ON rag.ingest_task_events (request_id, occurred_at)
    WHERE request_id IS NOT NULL;
