-- Scope daily_metrics row uniqueness by user to prevent cross-user collisions.

DROP INDEX IF EXISTS fitness.daily_metrics_date_provider_source_idx;
CREATE UNIQUE INDEX IF NOT EXISTS daily_metrics_date_provider_source_idx
  ON fitness.daily_metrics USING btree (user_id, date, provider_id, source_name) NULLS NOT DISTINCT;
