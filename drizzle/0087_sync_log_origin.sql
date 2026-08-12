ALTER TABLE fitness.sync_log
ADD COLUMN origin text NOT NULL DEFAULT 'unknown';

ALTER TABLE fitness.sync_log
ADD CONSTRAINT sync_log_origin_valid
CHECK (origin IN ('manual', 'scheduled', 'unknown'));

CREATE INDEX sync_log_user_origin_status_provider_synced_at_idx
ON fitness.sync_log (user_id, origin, status, provider_id, synced_at DESC);
