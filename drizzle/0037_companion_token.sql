CREATE TABLE IF NOT EXISTS fitness.companion_token (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES fitness.user_profile (id),
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz DEFAULT now() NOT NULL,
  revoked_at timestamptz
);

ALTER TABLE fitness.companion_token ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS companion_token_user_idx ON fitness.companion_token (user_id) WHERE revoked_at IS NULL;
