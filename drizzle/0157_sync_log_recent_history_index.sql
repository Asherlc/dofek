DROP INDEX fitness.sync_log_user_provider_synced_at_idx;--> statement-breakpoint
CREATE INDEX sync_log_user_provider_synced_at_idx ON fitness.sync_log USING btree (user_id, provider_id, synced_at DESC NULLS FIRST, id DESC NULLS FIRST);
