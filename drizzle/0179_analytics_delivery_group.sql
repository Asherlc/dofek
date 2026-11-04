ALTER TABLE fitness.analytics_stream_state
ADD COLUMN group_state TEXT,
ADD COLUMN group_first_position JSONB,
ADD COLUMN group_last_position JSONB,
ADD COLUMN group_member_count INTEGER,
ADD COLUMN group_positions_digest TEXT,
ADD COLUMN group_first_ingested_at TIMESTAMPTZ,
ADD CONSTRAINT analytics_stream_state_delivery_group CHECK (
    (
        group_state IS NULL
        AND group_first_position IS NULL
        AND group_last_position IS NULL
        AND group_member_count IS NULL
        AND group_positions_digest IS NULL
        AND group_first_ingested_at IS NULL
    ) OR (
        group_state IS NOT NULL
        AND group_first_position IS NOT NULL
        AND group_last_position IS NOT NULL
        AND group_member_count IS NOT NULL
        AND group_positions_digest IS NOT NULL
        AND group_first_ingested_at IS NOT NULL
        AND jsonb_typeof(group_first_position) = 'object'
        AND jsonb_typeof(group_last_position) = 'object'
        AND group_member_count BETWEEN 1 AND 500
        AND group_positions_digest ~ '^[a-f0-9]{64}$'
        AND (
            (
                group_state = 'pending' AND pending IS NOT NULL
                AND pending = group_last_position
            ) OR (
                group_state = 'completed' AND pending IS NULL
                AND processed IS NOT NULL AND processed = group_last_position
            )
        )
    )
);
