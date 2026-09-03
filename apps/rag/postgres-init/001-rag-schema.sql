CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS rag;

CREATE TABLE IF NOT EXISTS rag.documents (
    document_id UUID PRIMARY KEY,
    source_key TEXT NOT NULL UNIQUE,
    current_revision INTEGER NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS rag.document_revisions (
    document_id UUID NOT NULL REFERENCES rag.documents(document_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision > 0),
    content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    source_uri TEXT NOT NULL,
    parsed_uri TEXT,
    parser_name TEXT NOT NULL,
    parser_version TEXT,
    processing_profile TEXT NOT NULL CHECK (processing_profile IN ('text', 'visual', 'table', 'full')),
    lightrag_document_id TEXT UNIQUE,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (document_id, revision)
);

CREATE TABLE IF NOT EXISTS rag.chunks (
    chunk_id UUID PRIMARY KEY,
    document_id UUID NOT NULL,
    revision INTEGER NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    lightrag_chunk_id TEXT UNIQUE,
    token_count INTEGER CHECK (token_count >= 0),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (document_id, revision)
        REFERENCES rag.document_revisions(document_id, revision) ON DELETE CASCADE,
    UNIQUE (document_id, revision, ordinal)
);

CREATE TABLE IF NOT EXISTS rag.graph_facts (
    fact_id UUID PRIMARY KEY,
    document_id UUID NOT NULL,
    revision INTEGER NOT NULL,
    fact_sha256 TEXT NOT NULL CHECK (fact_sha256 ~ '^[0-9a-f]{64}$'),
    subject TEXT NOT NULL,
    predicate TEXT NOT NULL,
    object TEXT NOT NULL,
    evidence_chunk_id UUID REFERENCES rag.chunks(chunk_id) ON DELETE SET NULL,
    confidence DOUBLE PRECISION CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (document_id, revision)
        REFERENCES rag.document_revisions(document_id, revision) ON DELETE CASCADE,
    UNIQUE (document_id, revision, fact_sha256)
);

CREATE TABLE IF NOT EXISTS rag.ingest_tasks (
    task_id UUID PRIMARY KEY,
    document_id UUID NOT NULL,
    revision INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
        'queued', 'vector_ready', 'kg_pending', 'kg_running',
        'graph_ready', 'failed', 'cancelled'
    )),
    attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    error_detail TEXT,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    FOREIGN KEY (document_id, revision)
        REFERENCES rag.document_revisions(document_id, revision) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS document_revisions_content_sha256_idx
    ON rag.document_revisions (content_sha256);
CREATE INDEX IF NOT EXISTS chunks_document_revision_idx
    ON rag.chunks (document_id, revision);
CREATE INDEX IF NOT EXISTS graph_facts_document_revision_idx
    ON rag.graph_facts (document_id, revision);
CREATE INDEX IF NOT EXISTS graph_facts_fact_sha256_idx
    ON rag.graph_facts (fact_sha256);
CREATE INDEX IF NOT EXISTS ingest_tasks_status_requested_at_idx
    ON rag.ingest_tasks (status, requested_at);
