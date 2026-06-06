import { describe, expect, it } from "vitest";
import { parseMetricStreamArchiveObjectKey } from "./r2-replay.ts";

describe("parseMetricStreamArchiveObjectKey", () => {
  it("extracts topic, partition, and offset range from archive object keys", () => {
    expect(
      parseMetricStreamArchiveObjectKey(
        "metric-stream/v1/date=2026-06-06/hour=15/metric-stream-v1-2-100-199.jsonl.gz",
      ),
    ).toEqual({
      date: "2026-06-06",
      firstOffset: 100,
      hour: "15",
      lastOffset: 199,
      partition: 2,
      topic: "metric-stream-v1",
    });
  });

  it("rejects keys outside the metric-stream archive layout", () => {
    expect(() => parseMetricStreamArchiveObjectKey("exports/file.json")).toThrow(
      "Invalid metric-stream archive key",
    );
  });
});
