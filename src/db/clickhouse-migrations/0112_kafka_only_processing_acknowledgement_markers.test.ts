import { describe, expect, it } from "vitest";
import {
  METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE,
  metricStreamProcessingPositionConstraint,
} from "../../metric-stream/clickhouse-table.ts";
import { createMigration } from "./0112_kafka_only_processing_acknowledgement_markers.ts";

describe("0112 kafka-only processing acknowledgement markers", () => {
  it("narrows marker_transport and reinstalls the kafka-only position CHECK", () => {
    expect(createMigration()).toEqual({
      id: "0112_kafka_only_processing_acknowledgement_markers",
      statements: [
        `ALTER TABLE ${METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE}
        DROP CONSTRAINT IF EXISTS valid_marker_position`,
        `ALTER TABLE ${METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE}
        MODIFY COLUMN marker_transport Enum8('kafka' = 1) DEFAULT 'kafka'`,
        `ALTER TABLE ${METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE}
        ADD CONSTRAINT IF NOT EXISTS valid_marker_position CHECK ${metricStreamProcessingPositionConstraint()}`,
      ],
    });
  });
});
