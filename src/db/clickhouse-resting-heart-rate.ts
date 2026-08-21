import { loadClickHouseSql } from "./clickhouse-sql.ts";

export function buildRestingHeartRateSleepWindowTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS analytics.resting_heart_rate_sleep_window (
  sleep_id UUID,
  user_id UUID,
  started_at Nullable(DateTime64(6, 'UTC')),
  ended_at Nullable(DateTime64(6, 'UTC')),
  duration_seconds Nullable(Int64),
  sample_count UInt64,
  resting_hr Nullable(Int32),
  refresh_version UInt64,
  is_deleted UInt8,
  refreshed_at DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, sleep_id)`;
}

interface BuildRestingHeartRateCteSqlOptions {
  includeWindowStart?: boolean;
}

export function buildRestingHeartRateCteSql({
  includeWindowStart = true,
}: BuildRestingHeartRateCteSqlOptions = {}): string {
  return loadClickHouseSql("resting-heart-rate-query.cte.sql", {
    timezone_param: "{timezone:String}",
    user_id_param: "{userId:UUID}",
    window_start_predicate: includeWindowStart
      ? "AND toDate(toTimeZone(ended_at, {timezone:String})) > toDate({rhrWindowStart:String})"
      : "",
    end_date_param: "{rhrEndDate:String}",
  });
}
