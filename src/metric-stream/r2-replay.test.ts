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
      firstOffset: 100n,
      hour: "15",
      lastOffset: 199n,
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
      firstOffset: 1n,
      lastOffset: 2n,
      partition: 12,
      topic: "metric-stream-backfill-v1",
    });
  });

  it("preserves offsets above Number.MAX_SAFE_INTEGER", () => {
    expect(
      parseMetricStreamArchiveObjectKey(
        "metric-stream/v1/date=2026-06-06/hour=15/metric-stream-v1-2-9007199254740993-9007199254741999.jsonl.gz",
      ),
    ).toEqual({
      date: "2026-06-06",
      firstOffset: 9007199254740993n,
      hour: "15",
      lastOffset: 9007199254741999n,
      partition: 2,
      topic: "metric-stream-v1",
    });
  });

  it.each([".internal_topic", "topic_with_underscores", "metric.stream-v1"])(
    "preserves flat legacy topic %s and leading-zero offsets",
    (topic) => {
      expect(
        parseMetricStreamArchiveObjectKey(
          `metric-stream/v1/date=2026-06-06/hour=15/${topic}-0-0001-0002.jsonl.gz`,
        ),
      ).toMatchObject({ topic, firstOffset: 1n, lastOffset: 2n });
    },
  );

  it("rejects never-deployed Pulsar-native archive key grammar", () => {
    expect(() =>
      parseMetricStreamArchiveObjectKey(
        "metric-stream/v1/date=2026-11-05/hour=03/pulsar/epoch=e1/topic=persistent%3A%2F%2Fpublic%2Fdefault%2Fsensor/first=ff/last=00.jsonl.gz",
      ),
    ).toThrow("Invalid metric-stream archive key");
  });
});
