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
--> statement-breakpoint
CREATE TABLE fitness.analytics_stream_state (
  transport TEXT NOT NULL,
  epoch TEXT NOT NULL,
  topic TEXT NOT NULL,
  partition INTEGER NOT NULL,
  owner_id UUID NOT NULL,
  processed JSONB,
  pending JSONB,
  group_state TEXT,
  group_first_position JSONB,
  group_last_position JSONB,
  group_member_count INTEGER,
  group_positions_digest TEXT,
  group_first_ingested_at TIMESTAMPTZ,
  PRIMARY KEY (transport, epoch, topic, partition),
  CONSTRAINT analytics_stream_state_delivery_group CHECK (
    (
      group_state IS NULL
      AND group_first_position IS NULL AND group_last_position IS NULL
      AND group_member_count IS NULL AND group_positions_digest IS NULL
      AND group_first_ingested_at IS NULL
    ) OR (
      group_state IS NOT NULL
      AND group_first_position IS NOT NULL AND group_last_position IS NOT NULL
      AND group_member_count IS NOT NULL AND group_positions_digest IS NOT NULL
      AND group_first_ingested_at IS NOT NULL
      AND jsonb_typeof(group_first_position) = 'object'
      AND jsonb_typeof(group_last_position) = 'object'
      AND group_member_count BETWEEN 1 AND 500
      AND group_positions_digest ~ '^[a-f0-9]{64}$'
      AND (
        (group_state = 'pending' AND pending IS NOT NULL AND pending = group_last_position)
        OR (group_state = 'completed' AND pending IS NULL AND processed IS NOT NULL AND processed = group_last_position)
      )
    )
  )
);
