ALTER TABLE fitness.mcp_access_token
ADD COLUMN oauth_client_id text,
ADD COLUMN oauth_resource text;
--> statement-breakpoint

CREATE TABLE fitness.mcp_oauth_client (
  client_id text PRIMARY KEY,
  client_secret text,
  client_metadata jsonb NOT NULL,
  client_id_issued_at bigint,
  client_secret_expires_at bigint,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE fitness.mcp_oauth_authorization_code (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  code_hash text NOT NULL UNIQUE,
  client_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES fitness.user_profile (id) ON DELETE CASCADE,
  scopes text [] NOT NULL,
  code_challenge text NOT NULL,
  redirect_uri text NOT NULL,
  resource text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  consumed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE INDEX mcp_oauth_authorization_code_expires_idx
ON fitness.mcp_oauth_authorization_code (expires_at);
--> statement-breakpoint

CREATE TABLE fitness.mcp_oauth_refresh_token (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  client_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES fitness.user_profile (id) ON DELETE CASCADE,
  access_token_id uuid NOT NULL REFERENCES fitness.mcp_access_token (id) ON DELETE CASCADE,
  scopes text [] NOT NULL,
  resource text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  revoked_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE INDEX mcp_oauth_refresh_token_active_idx
ON fitness.mcp_oauth_refresh_token (client_id, revoked_at, expires_at);
