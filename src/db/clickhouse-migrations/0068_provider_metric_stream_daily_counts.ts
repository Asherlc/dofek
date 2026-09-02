import {
  METRIC_STREAM_PROVIDER_CURRENT_STATE_RECORDED_AT_PROJECTION,
  METRIC_STREAM_TABLE,
  metricStreamProviderCurrentStateRecordedAtProjectionDefinition,
} from "../../metric-stream/clickhouse-table.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0068_provider_metric_stream_daily_counts",
    statements: [
      `CREATE TABLE IF NOT EXISTS analytics.metric_stream_day_change (
  user_id UUID,
  provider_id String,
  recorded_date Date,
  changed_at SimpleAggregateFunction(max, DateTime64(9, 'UTC'))
)
ENGINE = AggregatingMergeTree
ORDER BY (user_id, provider_id, recorded_date)`,
      `CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.metric_stream_day_change_ingest
TO analytics.metric_stream_day_change
AS
SELECT
  user_id,
  provider_id,
  toDate(recorded_at) AS recorded_date,
  now64(9, 'UTC') AS changed_at
FROM ingest.metric_stream
GROUP BY user_id, provider_id, recorded_date`,
      `ALTER TABLE ${METRIC_STREAM_TABLE}
        ADD PROJECTION IF NOT EXISTS ${METRIC_STREAM_PROVIDER_CURRENT_STATE_RECORDED_AT_PROJECTION} (
          ${metricStreamProviderCurrentStateRecordedAtProjectionDefinition()}
        )`,
    ],
  };
}
