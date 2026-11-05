ALTER TABLE fitness.analytics_stage_cursor
ALTER COLUMN cursor DROP NOT NULL,
ADD COLUMN page_after JSONB,
ADD COLUMN page_size INTEGER,
ADD COLUMN page_publication_revision NUMERIC(20,0),
ADD COLUMN page_state TEXT,
ADD COLUMN page_next JSONB,
ADD COLUMN page_output_complete BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN page_effects_digest TEXT,
ADD CONSTRAINT analytics_stage_cursor_page CHECK (
    (page_state IS NULL AND page_after IS NULL AND page_size IS NULL
        AND page_publication_revision IS NULL AND page_next IS NULL)
    OR (page_state IS NOT NULL AND page_state IN ('pending','completed')
        AND page_size IS NOT NULL AND page_size BETWEEN 1 AND 20
        AND page_publication_revision IS NOT NULL
        AND page_publication_revision > 0 AND page_publication_revision <= 18446744073709551615
        AND (page_state <> 'completed' OR page_next IS NOT DISTINCT FROM cursor))
);
