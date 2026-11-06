import { describe, expect, it } from "vitest";
import {
  buildIngestMetricStreamCreateTableSql,
  buildMetricStreamProcessingAcknowledgementTableSql,
  METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE,
  METRIC_STREAM_PROVIDER_CURRENT_STATE_RECORDED_AT_PROJECTION,
  METRIC_STREAM_PROVIDER_EXTERNAL_ID_PROJECTION,
  METRIC_STREAM_USER_CHANNEL_RECORDED_AT_PROJECTION,
  metricStreamProcessingPositionConstraint,
  metricStreamProviderCurrentStateRecordedAtProjectionDefinition,
  metricStreamProviderExternalIdProjectionDefinition,
  metricStreamUserChannelRecordedAtProjectionDefinition,
} from "./clickhouse-table.ts";

describe("metricStreamProcessingPositionConstraint", () => {
  it("requires kafka offset XOR pulsar epoch/message id marker fields", () => {
    expect(metricStreamProcessingPositionConstraint()).toBe(
      `(marker_transport = 'kafka' AND isNotNull(marker_offset)
    AND isNull(marker_epoch) AND isNull(marker_message_id))
    OR (marker_transport = 'pulsar' AND isNull(marker_offset)
      AND notEmpty(ifNull(marker_epoch, '')) AND notEmpty(ifNull(marker_message_id, '')))`,
    );
  });
});

describe("buildMetricStreamProcessingAcknowledgementTableSql", () => {
  it("builds an idempotent exact batch acknowledgement table", () => {
    const sql = buildMetricStreamProcessingAcknowledgementTableSql();

    expect(sql).toContain(
      `CREATE TABLE IF NOT EXISTS ${METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE}`,
    );
    expect(sql).toContain("operation_id UUID");
    expect(sql).toContain("batch_id String");
    expect(sql).toContain("dataset_keys Array(String)");
    expect(sql).toContain("expected_event_count UInt64");
    expect(sql).toContain("topic String");
    expect(sql).toContain("topic_partition Int32");
    expect(sql).toContain("marker_offset Nullable(UInt64)");
    expect(sql).toContain("marker_transport Enum8('kafka' = 1, 'pulsar' = 2) DEFAULT 'kafka'");
    expect(sql).toContain(
      `CONSTRAINT valid_marker_position CHECK ${metricStreamProcessingPositionConstraint()}`,
    );
    expect(sql).toContain("ENGINE = ReplacingMergeTree(applied_at)");
    expect(sql).toContain("ORDER BY (operation_id, batch_id)");
  });
});

describe("metric-stream user/channel/day projection", () => {
  it("shares the covering raw-key definition with the current bootstrap", () => {
    const definition = metricStreamUserChannelRecordedAtProjectionDefinition();
    expect(METRIC_STREAM_USER_CHANNEL_RECORDED_AT_PROJECTION).toBe("by_user_channel_recorded_at");
    expect(definition).toContain("user_id, activity_id, channel, recorded_at, id");
    expect(definition).toContain("provider_id, scalar, version, ingested_at, is_deleted");
    expect(definition).toContain("ORDER BY (user_id, channel, recorded_at, activity_id, id)");
    expect(buildIngestMetricStreamCreateTableSql()).toContain(definition);
  });
});

describe("metric-stream provider external-ID projection", () => {
  it("covers replacement rows and orders external-ID lookups", () => {
    const definition = metricStreamProviderExternalIdProjectionDefinition();
    const tableSql = buildIngestMetricStreamCreateTableSql();

    expect(METRIC_STREAM_PROVIDER_EXTERNAL_ID_PROJECTION).toBe("by_provider_external_id");
    expect(definition).toContain("activity_id,");
    expect(definition).toContain("external_id,");
    expect(definition).toContain("is_deleted,");
    expect(definition).toContain("generation");
    expect(definition).toContain(
      "ORDER BY (user_id, provider_id, external_id, id, version, ingested_at)",
    );
    expect(tableSql).toContain(`PROJECTION ${METRIC_STREAM_PROVIDER_EXTERNAL_ID_PROJECTION}`);
  });
});

describe("metric-stream recorded-at current-state projection", () => {
  it("provides covering columns ordered for provider/day counts", () => {
    const definition = metricStreamProviderCurrentStateRecordedAtProjectionDefinition();
    const tableSql = buildIngestMetricStreamCreateTableSql();

    expect(METRIC_STREAM_PROVIDER_CURRENT_STATE_RECORDED_AT_PROJECTION).toBe(
      "by_provider_current_state_recorded_at",
    );
    expect(definition).toContain("user_id,");
    expect(definition).toContain("provider_id,");
    expect(definition).toContain("recorded_at,");
    expect(definition).toContain("ingested_at,");
    expect(definition).toContain("version,");
    expect(definition).toContain("is_deleted");
    expect(definition).toContain(
      "ORDER BY (user_id, provider_id, recorded_at, id, version, ingested_at)",
    );
    expect(definition).not.toContain("argMax(");
    expect(definition).not.toContain("GROUP BY");
    expect(tableSql).toContain(
      `PROJECTION ${METRIC_STREAM_PROVIDER_CURRENT_STATE_RECORDED_AT_PROJECTION}`,
    );
  });
});
