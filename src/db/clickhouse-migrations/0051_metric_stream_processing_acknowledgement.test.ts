import { describe, expect, it } from "vitest";
import { buildMetricStreamProcessingAcknowledgementTableSql } from "../../metric-stream/clickhouse-table.ts";
import { createMigration } from "./0051_metric_stream_processing_acknowledgement.ts";

describe("0051 metric stream processing acknowledgement migration", () => {
  it("creates the acknowledgement table", () => {
    expect(createMigration()).toEqual({
      id: "0051_metric_stream_processing_acknowledgement",
      statements: [buildMetricStreamProcessingAcknowledgementTableSql()],
    });
  });
});
