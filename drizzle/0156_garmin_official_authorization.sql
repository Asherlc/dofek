ALTER TABLE fitness.oauth_token
ADD COLUMN provider_account_lookup_id text;
--> statement-breakpoint

ALTER TABLE fitness.oauth_token
ADD COLUMN authorization_id uuid;
--> statement-breakpoint

CREATE INDEX oauth_token_provider_account_lookup_idx
ON fitness.oauth_token (provider_id, provider_account_lookup_id);
--> statement-breakpoint

CREATE UNIQUE INDEX oauth_token_garmin_account_owner_idx
ON fitness.oauth_token (provider_account_lookup_id)
WHERE provider_id = 'garmin' AND provider_account_lookup_id IS NOT NULL;
--> statement-breakpoint

DELETE FROM fitness.oauth_token
WHERE provider_id = 'garmin' AND scopes = 'garmin-connect-internal';
--> statement-breakpoint

DELETE FROM fitness.user_settings
WHERE key = 'garmin_sync_cursor';
