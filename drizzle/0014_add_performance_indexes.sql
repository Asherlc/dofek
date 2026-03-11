-- sync_log: the logs endpoint does ORDER BY synced_at DESC without a provider filter,
-- which can't use the existing composite index (provider_id, data_type, synced_at).
CREATE INDEX IF NOT EXISTS sync_log_synced_at_idx ON fitness.sync_log (synced_at DESC);
