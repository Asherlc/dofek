import {
  METRIC_STREAM_TABLE,
  METRIC_STREAM_USER_CHANNEL_RECORDED_AT_PROJECTION,
  metricStreamUserChannelRecordedAtProjectionDefinition,
} from "../../metric-stream/clickhouse-table.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0098_heart_rate_source_access",
    statements: [
      `ALTER TABLE ${METRIC_STREAM_TABLE}
        ADD PROJECTION IF NOT EXISTS ${METRIC_STREAM_USER_CHANNEL_RECORDED_AT_PROJECTION} (
          ${metricStreamUserChannelRecordedAtProjectionDefinition()}
        )`,
    ],
  };
}
