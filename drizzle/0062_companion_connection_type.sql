ALTER TABLE fitness.companion_token
RENAME TO companion_token_legacy;

CREATE TABLE fitness.companion_token (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  connection_type text DEFAULT 'zepp-main' NOT NULL,
  token_hash text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT companion_token_new_pkey PRIMARY KEY (id),
  CONSTRAINT companion_token_new_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES fitness.user_profile (id) ON DELETE CASCADE,
  CONSTRAINT companion_token_new_token_hash_key UNIQUE (token_hash),
  CONSTRAINT companion_token_connection_type_check
  CHECK (connection_type IN ('zepp-main', 'zepp-workout'))
);

ALTER TABLE fitness.companion_token ENABLE ROW LEVEL SECURITY;

INSERT INTO fitness.companion_token (
  id,
  user_id,
  connection_type,
  token_hash,
  created_at,
  revoked_at
)
SELECT
  id,
  user_id,
  'zepp-main' AS connection_type,
  token_hash,
  created_at,
  revoked_at
FROM fitness.companion_token_legacy;

DROP TABLE fitness.companion_token_legacy;

ALTER TABLE fitness.companion_token
RENAME CONSTRAINT companion_token_new_pkey TO companion_token_pkey;

ALTER TABLE fitness.companion_token
RENAME CONSTRAINT companion_token_new_user_id_fkey TO companion_token_user_id_fkey;

ALTER TABLE fitness.companion_token
RENAME CONSTRAINT companion_token_new_token_hash_key TO companion_token_token_hash_key;

CREATE UNIQUE INDEX companion_token_user_connection_type_idx
ON fitness.companion_token (user_id, connection_type)
WHERE revoked_at IS NULL;
