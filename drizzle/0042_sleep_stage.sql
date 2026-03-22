CREATE TABLE fitness.sleep_stage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES fitness.sleep_session(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL,
  source_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX sleep_stage_session_idx ON fitness.sleep_stage (session_id, started_at);
