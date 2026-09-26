ALTER TABLE fitness.mcp_oidc_adapter
ADD COLUMN user_id uuid;
--> statement-breakpoint
UPDATE fitness.mcp_oidc_adapter
SET user_id = uid::uuid
WHERE
  uid ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  AND user_id IS NULL;
--> statement-breakpoint
ALTER TABLE fitness.mcp_oidc_adapter
ADD CONSTRAINT mcp_oidc_adapter_user_id_user_profile_id_fk
FOREIGN KEY (user_id)
REFERENCES fitness.user_profile (id)
ON DELETE CASCADE
NOT VALID;
--> statement-breakpoint
ALTER TABLE fitness.mcp_oidc_adapter
VALIDATE CONSTRAINT mcp_oidc_adapter_user_id_user_profile_id_fk;
--> statement-breakpoint
CREATE INDEX mcp_oidc_adapter_user_idx
ON fitness.mcp_oidc_adapter (user_id);
--> statement-breakpoint
SELECT fitness.refresh_account_erasure_write_fences();
