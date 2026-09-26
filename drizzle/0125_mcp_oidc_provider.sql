CREATE TABLE fitness.mcp_oidc_adapter (
  model text NOT NULL,
  id text NOT NULL,
  payload jsonb NOT NULL,
  uid text,
  user_code text,
  grant_id text,
  expires_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY (model, id)
);
--> statement-breakpoint

CREATE INDEX mcp_oidc_adapter_uid_idx
ON fitness.mcp_oidc_adapter (model, uid);
--> statement-breakpoint

CREATE INDEX mcp_oidc_adapter_user_code_idx
ON fitness.mcp_oidc_adapter (model, user_code);
--> statement-breakpoint

CREATE INDEX mcp_oidc_adapter_grant_id_idx
ON fitness.mcp_oidc_adapter (model, grant_id);
--> statement-breakpoint

CREATE INDEX mcp_oidc_adapter_expires_idx
ON fitness.mcp_oidc_adapter (expires_at);
