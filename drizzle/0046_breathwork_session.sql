-- Breathwork session tracking
CREATE TABLE IF NOT EXISTS fitness.breathwork_session (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES fitness.user_profile(id),
  technique_id TEXT NOT NULL,
  rounds INTEGER NOT NULL,
  duration_seconds INTEGER NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS breathwork_session_user_idx
  ON fitness.breathwork_session (user_id);

CREATE INDEX IF NOT EXISTS breathwork_session_started_at_idx
  ON fitness.breathwork_session (started_at DESC);
