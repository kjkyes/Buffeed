-- P2/P3: persist parser artifact inventories, one-to-many LightRAG chunk
-- provenance, and graph-fact audit fields. Artifact payloads remain in the
-- durable artifact store; PostgreSQL stores only immutable metadata and links.

CREATE TABLE IF NOT EXISTS rag.parser_artifacts (
    parser_run_id UUID NOT NULL
        REFERENCES rag.parser_runs(parser_run_id) ON DELETE CASCADE,
    relative_path TEXT NOT NULL CHECK (relative_path <> ''),
    artifact_uri TEXT NOT NULL CHECK (artifact_uri <> ''),
    artifact_kind TEXT NOT NULL CHECK (artifact_kind <> ''),
    content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    byte_size BIGINT NOT NULL CHECK (byte_size >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (parser_run_id, relative_path)
);

CREATE INDEX IF NOT EXISTS parser_artifacts_parser_run_kind_idx
    ON rag.parser_artifacts (parser_run_id, artifact_kind);

CREATE TABLE IF NOT EXISTS rag.lightrag_chunk_links (
    document_id UUID NOT NULL,
    revision INTEGER NOT NULL,
    workspace TEXT NOT NULL CHECK (workspace <> ''),
    lightrag_chunk_id TEXT NOT NULL CHECK (lightrag_chunk_id <> ''),
    chunk_id UUID NOT NULL REFERENCES rag.chunks(chunk_id) ON DELETE CASCADE,
    link_ordinal INTEGER NOT NULL CHECK (link_ordinal >= 0),
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    mapping_kind TEXT NOT NULL CHECK (mapping_kind IN (
        'sidecar_ref', 'sidecar_modality_ref', 'legacy_column'
    )),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (document_id, revision, workspace, lightrag_chunk_id, chunk_id),
    FOREIGN KEY (document_id, revision)
        REFERENCES rag.document_revisions(document_id, revision)
        ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS lightrag_chunk_links_primary_idx
    ON rag.lightrag_chunk_links (workspace, lightrag_chunk_id)
    WHERE is_primary;
CREATE INDEX IF NOT EXISTS lightrag_chunk_links_lookup_idx
    ON rag.lightrag_chunk_links (workspace, lightrag_chunk_id, link_ordinal);
CREATE INDEX IF NOT EXISTS lightrag_chunk_links_chunk_idx
    ON rag.lightrag_chunk_links (chunk_id);

ALTER TABLE rag.graph_facts
    ADD COLUMN IF NOT EXISTS evidence_lightrag_chunk_id TEXT,
    ADD COLUMN IF NOT EXISTS graph_workspace TEXT,
    ADD COLUMN IF NOT EXISTS graph_edge_key TEXT;

CREATE INDEX IF NOT EXISTS graph_facts_lightrag_chunk_idx
    ON rag.graph_facts (document_id, revision, evidence_lightrag_chunk_id)
    WHERE evidence_lightrag_chunk_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS graph_facts_edge_provenance_idx
    ON rag.graph_facts (
        document_id, revision, graph_workspace,
        graph_edge_key, evidence_lightrag_chunk_id, evidence_chunk_id
    )
    WHERE graph_workspace IS NOT NULL
      AND graph_edge_key IS NOT NULL
      AND evidence_lightrag_chunk_id IS NOT NULL
      AND evidence_chunk_id IS NOT NULL;
