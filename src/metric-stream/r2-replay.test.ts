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

  it("retains native endpoint bytes as opaque upload provenance", () => {
    expect(parseMetricStreamArchiveObjectKey(nativeKey())).toEqual({
      transport: "pulsar",
      date: "2026-11-05",
      hour: "03",
      epoch: "epoch/1",
      topic: "persistent://public/default/sensor-partition-2",
      firstHex: "ff",
      lastHex: "00",
    });
  });

  it("accepts the native key byte boundary and rejects the next byte", () => {
    const epoch = "x".repeat(1024 - Buffer.byteLength(nativeKey({ epoch: "" })));
    const key = nativeKey({ epoch });
    expect(Buffer.byteLength(key)).toBe(1024);
    expect(parseMetricStreamArchiveObjectKey(key)).toMatchObject({ epoch });
    expect(() => parseMetricStreamArchiveObjectKey(nativeKey({ epoch: `${epoch}x` }))).toThrow(
      "key exceeds",
    );
  });

  it.each([
    ["empty epoch", nativeKey({ epoch: "" })],
    ["empty first endpoint", nativeKey({ firstHex: "" })],
    ["empty last endpoint", nativeKey({ lastHex: "" })],
    ["odd endpoint hex", nativeKey({ firstHex: "080" })],
    ["uppercase endpoint hex", nativeKey({ lastHex: "FF" })],
    ["invalid UTC date", nativeKey().replace("2026-11-05", "2026-02-30")],
    ["invalid UTC hour", nativeKey().replace("hour=03", "hour=24")],
    ["alternate percent escape", nativeKey().replace("%3A", "%3a")],
    ["malformed percent escape", nativeKey().replace("%3A", "%ZZ")],
    ["escaped unreserved component", nativeKey().replace("epoch%2F1", "%65%70%6F%63%68%2F1")],
    ["unescaped epoch slash", nativeKey().replace("epoch%2F1", "epoch/1")],
    ["incomplete topic", nativeKey({ topic: "persistent://public/default" })],
    ["empty topic component", nativeKey({ topic: "persistent://public//sensor" })],
    ["nonpersistent topic", nativeKey({ topic: "non-persistent://public/default/sensor" })],
    [
      "unknown nested layout",
      "metric-stream/v1/date=2026-11-05/hour=03/other/topic-2-1-2.jsonl.gz",
    ],
    [
      "unknown native layout",
      "metric-stream/v1/date=2026-11-05/hour=03/pulsar/topic-2-1-2.jsonl.gz",
    ],
  ])("rejects %s", (_reason, key) => {
    expect(() => parseMetricStreamArchiveObjectKey(key)).toThrow();
  });
});

function nativeKey({
  epoch = "epoch/1",
  topic = "persistent://public/default/sensor-partition-2",
  firstHex = "ff",
  lastHex = "00",
} = {}): string {
  return `metric-stream/v1/date=2026-11-05/hour=03/pulsar/epoch=${encodeURIComponent(epoch)}/topic=${encodeURIComponent(topic)}/first=${firstHex}/last=${lastHex}.jsonl.gz`;
}
