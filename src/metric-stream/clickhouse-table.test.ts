import { describe, expect, it } from "vitest";
import {
  buildIngestMetricStreamCreateTableSql,
  buildMetricStreamProcessingAcknowledgementTableSql,
  METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE,
  METRIC_STREAM_PROVIDER_CURRENT_STATE_RECORDED_AT_PROJECTION,
  metricStreamProviderCurrentStateRecordedAtProjectionDefinition,
} from "./clickhouse-table.ts";

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
    expect(sql).toContain("partition Int32");
    expect(sql).toContain("marker_offset UInt64");
    expect(sql).toContain("ENGINE = ReplacingMergeTree(applied_at)");
    expect(sql).toContain("ORDER BY (operation_id, batch_id)");
  });
});

describe("metric-stream recorded-at current-state projection", () => {
  it("provides latest state ordered for provider/day counts", () => {
    const definition = metricStreamProviderCurrentStateRecordedAtProjectionDefinition();
    const tableSql = buildIngestMetricStreamCreateTableSql();

    expect(METRIC_STREAM_PROVIDER_CURRENT_STATE_RECORDED_AT_PROJECTION).toBe(
      "by_provider_current_state_recorded_at",
    );
    expect(definition).toContain("argMax(recorded_at, tuple(version, ingested_at)) AS recorded_at");
    expect(definition).toContain("argMax(ingested_at, tuple(version, ingested_at)) AS ingested_at");
    expect(definition).toContain("argMax(version, tuple(version, ingested_at)) AS version");
    expect(definition).toContain("argMax(is_deleted, tuple(version, ingested_at)) AS is_deleted");
    expect(definition).toContain("GROUP BY user_id, provider_id, id");
    expect(definition).toContain("ORDER BY (user_id, provider_id, recorded_at, id)");
    expect(tableSql).toContain(
      `PROJECTION ${METRIC_STREAM_PROVIDER_CURRENT_STATE_RECORDED_AT_PROJECTION}`,
    );
  });
});
