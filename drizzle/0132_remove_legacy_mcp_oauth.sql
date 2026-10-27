-- Deploy the issuer-managed MCP token implementation before this migration.
-- Remove legacy OAuth token rows as an explicit operator action first; retaining
-- them after dropping their discriminator would expose them as personal tokens.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM fitness.mcp_access_token WHERE oauth_client_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Remove legacy MCP OAuth access-token rows before schema cleanup';
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE fitness.mcp_oauth_refresh_token;
--> statement-breakpoint
DROP TABLE fitness.mcp_oauth_authorization_code;
--> statement-breakpoint
DROP TABLE fitness.mcp_oauth_client;
--> statement-breakpoint
ALTER TABLE fitness.mcp_access_token DROP COLUMN oauth_client_id;
--> statement-breakpoint
ALTER TABLE fitness.mcp_access_token DROP COLUMN oauth_resource;
