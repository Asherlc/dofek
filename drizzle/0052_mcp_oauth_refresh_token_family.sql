ALTER TABLE fitness.mcp_oauth_refresh_token
ADD COLUMN parent_refresh_token_id uuid;
--> statement-breakpoint

ALTER TABLE fitness.mcp_oauth_refresh_token
ADD CONSTRAINT mcp_oauth_refresh_token_parent_fk
FOREIGN KEY (parent_refresh_token_id)
REFERENCES fitness.mcp_oauth_refresh_token (id)
ON DELETE CASCADE
NOT VALID;
--> statement-breakpoint

ALTER TABLE fitness.mcp_oauth_refresh_token
VALIDATE CONSTRAINT mcp_oauth_refresh_token_parent_fk;
--> statement-breakpoint

CREATE INDEX mcp_oauth_refresh_token_parent_idx
ON fitness.mcp_oauth_refresh_token (parent_refresh_token_id);
