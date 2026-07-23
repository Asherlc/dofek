import { describe, expect, it } from "vitest";
import {
  buildMetricStreamProcessingAcknowledgementTableSql,
  METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE,
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
