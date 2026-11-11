/** Typed samples are decoded by dbt; callers retain their local-day/source selection. */
export function healthSensorSamplesSql(channel: "spo2" | "skin_temperature"): string {
  return `SELECT sample.id AS id, sample.measured_at AS recorded_at,
      provider_id, sample.source_name AS source_name, sample.value AS scalar
    FROM analytics.daily_health_sensor FINAL
    ARRAY JOIN samples AS sample
    WHERE user_id = {userId:UUID} AND sample.channel = '${channel}'`;
}
