-- ============================================================
-- Migration 0038: Backfill SpO2 daily averages from metric_stream
-- ============================================================
-- Apple Health stored SpO2 readings in metric_stream (as fractions 0-1)
-- but never aggregated them into daily_metrics.spo2_avg (as percentage 0-100).
-- This backfills historical data so the dashboard chart shows existing readings.

INSERT INTO fitness.daily_metrics (date, provider_id, user_id, spo2_avg)
SELECT
  (recorded_at AT TIME ZONE 'UTC')::date AS date,
  provider_id,
  user_id,
  AVG(spo2) * 100 AS spo2_avg
FROM fitness.metric_stream
WHERE spo2 IS NOT NULL
GROUP BY (recorded_at AT TIME ZONE 'UTC')::date, provider_id, user_id
ON CONFLICT (date, provider_id) DO UPDATE SET
  spo2_avg = EXCLUDED.spo2_avg;

--> statement-breakpoint

-- Refresh the materialized view so the dashboard picks up the new data
REFRESH MATERIALIZED VIEW CONCURRENTLY fitness.v_daily_metrics;
