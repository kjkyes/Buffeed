-- P3: PostgreSQL FTS indexes used beside LightRAG vector retrieval and KG facts.
-- The expressions match RAG_HYBRID_FTS_CONFIG=simple in .env.example.

CREATE INDEX IF NOT EXISTS chunks_content_simple_fts_idx
    ON rag.chunks
    USING GIN (to_tsvector('simple', content))
    WHERE chunk_kind = 'child';

CREATE INDEX IF NOT EXISTS graph_facts_simple_fts_idx
    ON rag.graph_facts
    USING GIN (
        to_tsvector('simple', subject || ' ' || predicate || ' ' || object)
    );
