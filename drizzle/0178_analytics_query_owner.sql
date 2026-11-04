CREATE TABLE fitness.analytics_query_owner (
    resource_id TEXT PRIMARY KEY,
    owner_id UUID,
    backend_pid INTEGER,
    quiescent BOOLEAN NOT NULL DEFAULT TRUE,
    intent_id TEXT,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT 'epoch',
    query_id UUID,
    query_terminal BOOLEAN NOT NULL DEFAULT TRUE
);
