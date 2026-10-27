CREATE INDEX IF NOT EXISTS sync_log_user_provider_synced_at_idx
ON fitness.sync_log (user_id, provider_id, synced_at DESC);
