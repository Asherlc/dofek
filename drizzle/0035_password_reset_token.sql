CREATE TABLE fitness.password_reset_token (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  consumed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT password_reset_token_pkey PRIMARY KEY (id),
  CONSTRAINT password_reset_token_token_hash_key UNIQUE (token_hash),
  CONSTRAINT password_reset_token_user_id_fkey FOREIGN KEY (user_id) REFERENCES fitness.user_profile (id) ON DELETE CASCADE
);

CREATE INDEX password_reset_token_user_idx ON fitness.password_reset_token USING btree (user_id); -- noqa: PG01
CREATE INDEX password_reset_token_active_idx ON fitness.password_reset_token USING btree (token_hash, expires_at) WHERE consumed_at IS NULL; -- noqa: PG01
