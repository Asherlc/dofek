import {
  METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE,
  metricStreamProcessingPositionConstraint,
} from "../../metric-stream/clickhouse-table.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0111_native_processing_acknowledgement",
    statements: [
      `ALTER TABLE ${METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE}
        MODIFY COLUMN marker_offset Nullable(UInt64),
        ADD COLUMN IF NOT EXISTS marker_transport Enum8('kafka' = 1, 'pulsar' = 2) DEFAULT 'kafka',
        ADD COLUMN IF NOT EXISTS marker_epoch Nullable(String),
        ADD COLUMN IF NOT EXISTS marker_message_id Nullable(String)`,
      `ALTER TABLE ${METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE}
        ADD CONSTRAINT IF NOT EXISTS valid_marker_position CHECK ${metricStreamProcessingPositionConstraint()}`,
    ],
  };
}
