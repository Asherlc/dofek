import {
  METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE,
  metricStreamProcessingPositionConstraint,
} from "../../metric-stream/clickhouse-table.ts";
import type { ClickHouseMigration } from "./types.ts";

/**
 * Narrow processing-ack marker transport after the Kafka steady-state pivot.
 *
 * Historical `0111_native_processing_acknowledgement` is left unchanged: it added
 * `Enum8('kafka','pulsar')` and a XOR constraint. Pulsar was never a production
 * writer for this table (inserts omit transport and rely on DEFAULT 'kafka'), so
 * preexisting rows should already be kafka-only. This forward migration drops the
 * Pulsar-admitting CHECK/enum so active schema matches app fail-closed kafka
 * positions. Do not rewrite 0111.
 */
export function createMigration(): ClickHouseMigration {
  return {
    id: "0112_kafka_only_processing_acknowledgement_markers",
    statements: [
      `ALTER TABLE ${METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE}
        DROP CONSTRAINT IF EXISTS valid_marker_position`,
      `ALTER TABLE ${METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE}
        MODIFY COLUMN marker_transport Enum8('kafka' = 1) DEFAULT 'kafka'`,
      `ALTER TABLE ${METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE}
        ADD CONSTRAINT IF NOT EXISTS valid_marker_position CHECK ${metricStreamProcessingPositionConstraint()}`,
    ],
  };
}
