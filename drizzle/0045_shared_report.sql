-- Shared health reports — allows users to generate shareable report links
CREATE TABLE IF NOT EXISTS fitness.shared_report (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES fitness.user_profile(id),
  share_token TEXT NOT NULL UNIQUE,
  report_type TEXT NOT NULL, -- 'weekly', 'monthly', 'healthspan'
  report_data JSONB NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shared_report_user_idx
  ON fitness.shared_report (user_id);

CREATE UNIQUE INDEX IF NOT EXISTS shared_report_token_idx
  ON fitness.shared_report (share_token);
