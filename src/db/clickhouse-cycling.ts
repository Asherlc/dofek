export const dailyCyclingActivitiesType =
  "Array(Tuple(UUID, DateTime64(6, 'UTC'), Float64, Nullable(Float64), Nullable(Float64), Nullable(Float64), UInt64, UInt64, Nullable(String)))";

export function buildDailyCyclingTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS analytics.daily_cycling (
    user_id UUID,
    date Date,
    activities ${dailyCyclingActivitiesType},
    is_deleted UInt8,
    refresh_version UInt64,
    refreshed_at DateTime64(9, 'UTC')
  ) ENGINE=ReplacingMergeTree(refresh_version) ORDER BY (user_id,date)`;
}
