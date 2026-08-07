CREATE TABLE fitness.mcp_access_token (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  name text NOT NULL,
  token_hash text NOT NULL,
  scopes text [] NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  last_used_at timestamp with time zone,
  expires_at timestamp with time zone,
  revoked_at timestamp with time zone,
  CONSTRAINT mcp_access_token_pkey PRIMARY KEY (id),
  CONSTRAINT mcp_access_token_user_id_fkey FOREIGN KEY (user_id) REFERENCES fitness.user_profile (id) ON DELETE CASCADE,
  CONSTRAINT mcp_access_token_token_hash_key UNIQUE (token_hash)
);

CREATE INDEX mcp_access_token_user_idx ON fitness.mcp_access_token USING btree (user_id);
CREATE INDEX mcp_access_token_token_hash_idx ON fitness.mcp_access_token USING btree (token_hash);
CREATE INDEX mcp_access_token_active_idx ON fitness.mcp_access_token USING btree (user_id, revoked_at, expires_at);
