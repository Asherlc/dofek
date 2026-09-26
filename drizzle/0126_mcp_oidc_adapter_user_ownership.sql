ALTER TABLE fitness.mcp_oidc_adapter
ADD COLUMN user_id uuid REFERENCES fitness.user_profile (id) ON DELETE CASCADE;
--> statement-breakpoint
UPDATE fitness.mcp_oidc_adapter
SET user_id = uid::uuid
WHERE
  uid ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  AND user_id IS NULL;
--> statement-breakpoint
CREATE INDEX mcp_oidc_adapter_user_idx
ON fitness.mcp_oidc_adapter (user_id);
--> statement-breakpoint
SELECT fitness.refresh_account_erasure_write_fences();
