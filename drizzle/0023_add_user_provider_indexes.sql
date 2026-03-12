-- Add (user_id, provider_id) indexes to all data tables for fast
-- per-user COUNT(*) GROUP BY provider_id queries (used by providerStats endpoint).
-- Also add a synced_at DESC index on sync_log for the logs endpoint.

CREATE INDEX IF NOT EXISTS activity_user_provider_idx
  ON fitness.activity (user_id, provider_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS daily_metrics_user_provider_idx
  ON fitness.daily_metrics (user_id, provider_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sleep_session_user_provider_idx
  ON fitness.sleep_session (user_id, provider_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS body_measurement_user_provider_idx
  ON fitness.body_measurement (user_id, provider_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS food_entry_user_provider_idx
  ON fitness.food_entry (user_id, provider_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS health_event_user_provider_idx
  ON fitness.health_event (user_id, provider_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS metric_stream_user_provider_idx
  ON fitness.metric_stream (user_id, provider_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS nutrition_daily_user_provider_idx
  ON fitness.nutrition_daily (user_id, provider_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS lab_result_user_provider_idx
  ON fitness.lab_result (user_id, provider_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS journal_entry_user_provider_idx
  ON fitness.journal_entry (user_id, provider_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sync_log_synced_at_idx
  ON fitness.sync_log (synced_at DESC);
