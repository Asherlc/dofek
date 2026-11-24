import type { ClickHouseMigration } from "./types.ts";

const epochHeartRateChangedAt = "toDateTime64('1970-01-01 00:00:00', 9, 'UTC')";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0119_heart_rate_changed_at",
    statements: [
      `ALTER TABLE analytics.deduped_sensor
  ADD COLUMN IF NOT EXISTS heart_rate_changed_at DateTime64(9, 'UTC')
  DEFAULT ${epochHeartRateChangedAt}`,
      `ALTER TABLE analytics.heart_rate_day_change_ingest
MODIFY QUERY
SELECT
  user_id,
  recorded_date,
  max(heart_rate_changed_at) AS changed_at
FROM analytics.deduped_sensor
WHERE channel = 'heart_rate'
  AND heart_rate_changed_at > ${epochHeartRateChangedAt}
GROUP BY user_id, recorded_date`,
    ],
  };
}
