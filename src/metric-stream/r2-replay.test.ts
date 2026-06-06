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

  it("rejects archive keys with missing date partitions", () => {
    expect(() =>
      parseMetricStreamArchiveObjectKey(
        "metric-stream/v1/hour=15/metric-stream-v1-2-100-199.jsonl.gz",
      ),
    ).toThrow("Invalid metric-stream archive key");
  });

  it("rejects archive keys with nonnumeric offsets", () => {
    expect(() =>
      parseMetricStreamArchiveObjectKey(
        "metric-stream/v1/date=2026-06-06/hour=15/metric-stream-v1-2-start-199.jsonl.gz",
      ),
    ).toThrow("Invalid metric-stream archive key");
  });

  it("keeps topics with dashes intact", () => {
    expect(
      parseMetricStreamArchiveObjectKey(
        "metric-stream/v1/date=2026-06-06/hour=15/metric-stream-backfill-v1-12-1-2.jsonl.gz",
      ),
    ).toMatchObject({
      firstOffset: 1,
      lastOffset: 2,
      partition: 12,
      topic: "metric-stream-backfill-v1",
    });
  });
});
