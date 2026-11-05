import Pulsar from "pulsar-client";
import { describe, expect, it } from "vitest";
import { parseMetricStreamArchiveObjectKey } from "./r2-replay.ts";

const first = Pulsar.MessageId.deserialize(Buffer.from("080a10e70718022001", "hex"));
const last = Pulsar.MessageId.deserialize(Buffer.from("080a10e70718022002", "hex"));

describe("parseMetricStreamArchiveObjectKey", () => {
  it("extracts topic, partition, and offset range from archive object keys", () => {
    expect(
      parseMetricStreamArchiveObjectKey(
        "metric-stream/v1/date=2026-06-06/hour=15/metric-stream-v1-2-100-199.jsonl.gz",
      ),
    ).toEqual({
      transport: "kafka",
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
      transport: "kafka",
      date: "2026-06-06",
      firstOffset: 9007199254740993n,
      hour: "15",
      lastOffset: 9007199254741999n,
      partition: 2,
      topic: "metric-stream-v1",
    });
  });

  it.each([".internal_topic", "topic_with_underscores", "metric.stream-v1"])(
    "preserves valid flat legacy topic %s",
    (topic) => {
      expect(
        parseMetricStreamArchiveObjectKey(
          `metric-stream/v1/date=2026-06-06/hour=15/${topic}-0-0001-0002.jsonl.gz`,
        ),
      ).toMatchObject({ transport: "kafka", topic, firstOffset: 1n, lastOffset: 2n });
    },
  );

  it("decodes native batch identities without deriving Kafka offsets", () => {
    const key = nativeKey();
    expect(parseMetricStreamArchiveObjectKey(key)).toEqual({
      transport: "pulsar",
      date: "2026-11-05",
      hour: "03",
      first: {
        transport: "pulsar",
        epoch: "epoch/1",
        topic: "persistent://public/default/sensor-partition-2",
        partition: 2,
        serializedMessageId: first.serialize().toString("base64"),
        delivery: { major: "10", minor: "999", batch: 1 },
      },
      last: {
        transport: "pulsar",
        epoch: "epoch/1",
        topic: "persistent://public/default/sensor-partition-2",
        partition: 2,
        serializedMessageId: last.serialize().toString("base64"),
        delivery: { major: "10", minor: "999", batch: 2 },
      },
    });
  });

  it("accepts a single native delivery on a topic without partitions", () => {
    const id = Pulsar.MessageId.deserialize(Buffer.from("080a1000", "hex"));
    expect(
      parseMetricStreamArchiveObjectKey(
        nativeKey({ topic: "persistent://public/default/sensor", firstId: id, lastId: id }),
      ),
    ).toMatchObject({
      transport: "pulsar",
      first: { partition: -1, delivery: { major: "10", minor: "0", batch: -1 } },
      last: { partition: -1, delivery: { major: "10", minor: "0", batch: -1 } },
    });
  });

  it("preserves native coordinates beyond JavaScript integer precision", () => {
    const id = Pulsar.MessageId.deserialize(
      Buffer.from("08818080808080801010828080808080801018022003", "hex"),
    );
    expect(parseMetricStreamArchiveObjectKey(nativeKey({ firstId: id, lastId: id }))).toMatchObject(
      {
        transport: "pulsar",
        first: { delivery: { major: "9007199254740993", minor: "9007199254740994", batch: 3 } },
        last: { serializedMessageId: id.serialize().toString("base64") },
      },
    );
  });

  it("preserves the full serialized identity of native batched messages", () => {
    const id = Pulsar.MessageId.deserialize(Buffer.from("080a10e70718022001300a", "hex"));
    expect(parseMetricStreamArchiveObjectKey(nativeKey({ firstId: id, lastId: id }))).toMatchObject(
      {
        first: { serializedMessageId: id.serialize().toString("base64"), delivery: { batch: 1 } },
        last: { serializedMessageId: id.serialize().toString("base64"), delivery: { batch: 1 } },
      },
    );
  });

  it.each([
    [
      "partition zero",
      "080a10e70718002001",
      "persistent://public/default/sensor-partition-0",
      0,
      1,
    ],
    [
      "batch index zero",
      "080a10e70718022000",
      "persistent://public/default/sensor-partition-2",
      2,
      0,
    ],
    [
      "partition and batch index zero",
      "080a10e70718002000300a",
      "persistent://public/default/sensor-partition-0",
      0,
      0,
    ],
  ])("preserves native optional-field presence for %s", (_reason, hex, topic, partition, batch) => {
    const id = Pulsar.MessageId.deserialize(Buffer.from(hex, "hex"));
    expect(
      parseMetricStreamArchiveObjectKey(nativeKey({ firstId: id, lastId: id, topic })),
    ).toMatchObject({
      transport: "pulsar",
      first: {
        partition,
        serializedMessageId: id.serialize().toString("base64"),
        delivery: { batch },
      },
      last: {
        partition,
        serializedMessageId: id.serialize().toString("base64"),
        delivery: { batch },
      },
    });
  });

  it("rejects acknowledgement-set IDs that the pinned native serializer does not produce", () => {
    const key = nativeKey().replace(
      first.serialize().toString("hex"),
      "080a10e7071802200128012802",
    );
    expect(() => parseMetricStreamArchiveObjectKey(key)).toThrow(
      "Acknowledgement-set native archive message IDs are not qualified",
    );
  });

  it.each([
    ["truncated variable-length integer", "0880"],
    ["missing required entry ID", "080a"],
    ["missing required ledger ID", "1000"],
    ["wrong required-field wire type", "0a010a1000"],
    ["malformed nested ID", "080a10003a01ff"],
    ["unsupported chunk ID", "080a1000180220013a0408091000"],
    ["unknown protobuf field", "080a1000180220014000"],
    ["ledger exceeds signed int64", "08ffffffffffffffffff01100018022001"],
    ["partition exceeds int32", "080a10001880808080082001"],
    ["batch exceeds int32", "080a10001802208080808008"],
    ["overlong native key", "08".repeat(600)],
  ])("rejects %s before native deserialization can terminate the process", (_reason, hex) => {
    const key = nativeKey().replace(first.serialize().toString("hex"), hex);
    expect(() => parseMetricStreamArchiveObjectKey(key)).toThrow();
  });

  it.each([
    [
      "first partition mismatch",
      nativeKey({ firstId: Pulsar.MessageId.deserialize(Buffer.from("080a100018012001", "hex")) }),
    ],
    [
      "last partition mismatch",
      nativeKey({ lastId: Pulsar.MessageId.deserialize(Buffer.from("080a100018012002", "hex")) }),
    ],
    [
      "partitioned ID without topic suffix",
      nativeKey({ topic: "persistent://public/default/sensor" }),
    ],
    ["reversed batch range", nativeKey({ firstId: last, lastId: first })],
    ["alternate topic escape", nativeKey().replace("%3A", "%3a")],
    ["malformed topic escape", nativeKey().replace("%3A", "%ZZ")],
    ["unescaped epoch slash", nativeKey().replace("epoch%2F1", "epoch/1")],
    ["empty epoch", nativeKey().replace("epoch%2F1", "")],
    ["invalid UTC archive date", nativeKey().replace("2026-11-05", "2026-02-30")],
    ["invalid UTC archive hour", nativeKey().replace("hour=03", "hour=24")],
    [
      "non-persistent topic",
      nativeKey({ topic: "non-persistent://public/default/sensor-partition-2" }),
    ],
    ["incomplete concrete topic", nativeKey({ topic: "persistent://sensor-partition-2" })],
    ["invalid native ID bytes", nativeKey().replace(first.serialize().toString("hex"), "ff")],
    [
      "uppercase native ID hex",
      nativeKey().replace(
        first.serialize().toString("hex"),
        first.serialize().toString("hex").toUpperCase(),
      ),
    ],
    ["odd native ID hex", nativeKey().replace(first.serialize().toString("hex"), "080")],
    [
      "latest sentinel",
      nativeKey({ firstId: Pulsar.MessageId.latest(), lastId: Pulsar.MessageId.latest() }),
    ],
    [
      "unknown nested legacy form",
      "metric-stream/v1/date=2026-11-05/hour=03/other/topic-2-1-2.jsonl.gz",
    ],
    [
      "malformed native branch resembling legacy",
      "metric-stream/v1/date=2026-11-05/hour=03/pulsar/topic-2-1-2.jsonl.gz",
    ],
  ])("rejects %s", (_reason, key) => {
    expect(() => parseMetricStreamArchiveObjectKey(key)).toThrow();
  });
});

function nativeKey({
  topic = "persistent://public/default/sensor-partition-2",
  firstId = first,
  lastId = last,
} = {}): string {
  return `metric-stream/v1/date=2026-11-05/hour=03/pulsar/epoch=epoch%2F1/topic=${encodeURIComponent(topic)}/first=${firstId.serialize().toString("hex")}/last=${lastId.serialize().toString("hex")}.jsonl.gz`;
}
