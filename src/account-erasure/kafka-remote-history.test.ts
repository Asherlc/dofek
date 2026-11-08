import kafkaJs from "kafkajs";
import { describe, expect, it, vi } from "vitest";
import { KafkaRemoteHistory } from "./kafka-remote-history.ts";

const boundary = {
  topic: "samples",
  topicId: "dI2O6HVWQkuC7XgSy7cJ3w",
  partition: 0,
  low: "100",
  offset: "100",
};
const identity =
  "0873616d706c6573748d8ee87556424b82ed7812cbb709df00000000000000000000000000000000000000000100";
const start = Buffer.from(
  [
    "010000",
    identity,
    "00000000000000000000000000000063",
    "00000001",
    "00000000000000000000000000000064",
    "0200000000000000000000000000",
    "00000400000000",
  ].join(""),
  "hex",
);
const update = (state: number) =>
  Buffer.from(
    `010100${identity}00000001000000000000006500${state.toString(16).padStart(2, "0")}00`,
    "hex",
  );

function fixture(
  values: Array<Buffer | null>,
  low = "0",
  partition = 0,
  offsets = values.map((_, index) => String(index)),
) {
  const disconnect = vi.fn(async () => {});
  const consumer = new kafkaJs.Kafka({
    brokers: ["fixture:9092"],
    logLevel: kafkaJs.logLevel.NOTHING,
  }).consumer({ groupId: "fixture" });
  vi.spyOn(consumer, "connect").mockResolvedValue();
  vi.spyOn(consumer, "disconnect").mockImplementation(disconnect);
  vi.spyOn(consumer, "subscribe").mockResolvedValue();
  vi.spyOn(consumer, "run").mockImplementation(async (options) => {
    if (!options?.eachBatch) throw new Error("missing fixture batch callback");
    await options.eachBatch({
      batch: {
        topic: "__remote_log_metadata",
        partition,
        highWatermark: String(values.length),
        isEmpty: () => values.length === 0,
        firstOffset: () => "0",
        lastOffset: () => String(values.length - 1),
        offsetLag: () => "0",
        offsetLagLow: () => "0",
        messages: values.map((value, index) => ({
          offset: offsets[index] ?? String(index),
          value,
          key: null,
          timestamp: "0",
          attributes: 0,
          headers: {},
        })),
      },
      heartbeat: async () => {},
      resolveOffset: () => {},
      commitOffsetsIfNecessary: async () => {},
      uncommittedOffsets: () => ({ topics: [] }),
      isRunning: () => true,
      isStale: () => false,
      pause: () => () => {},
    });
  });
  const admin = {
    fetchTopicOffsets: vi.fn(async () => [
      { partition: 0, low, high: String(values.length), offset: String(values.length) },
    ]),
  };
  return { reader: new KafkaRemoteHistory(admin, () => consumer), disconnect, admin, consumer };
}

describe("native Kafka deletion history", () => {
  it("requires terminal deletion for every covered attempt and closes the consumer", async () => {
    const { reader, disconnect } = fixture([start, update(1), update(2), update(3)]);
    const result = await reader.assertDeleted([boundary]);
    expect(result.get("AAAAAAAAAAAAAAAAAAAAAQ")).toMatchObject({
      topic: "samples",
      startOffset: "0",
    });
    expect(disconnect).toHaveBeenCalledOnce();
  });
  it.each([[start], [start, update(1)], [start, update(2)]])(
    "blocks unfinished native copies/deletes",
    async (...values) => {
      await expect(fixture(values).reader.assertDeleted([boundary])).rejects.toThrow("unfinished");
    },
  );
  it("allows failed copies once stock cleanup records terminal deletion", async () => {
    await expect(
      fixture([start, update(2), update(3)]).reader.assertDeleted([boundary]),
    ).resolves.toBeInstanceOf(Map);
  });
  it.each([[null], [update(3)], [Buffer.from([1, 7, 0])]])(
    "rejects tombstones, missing admission and unknown schemas",
    async (...values) => {
      await expect(fixture(values).reader.assertDeleted([boundary])).rejects.toThrow();
    },
  );
  it("rejects trimmed history and unexpected metadata partitions", async () => {
    await expect(fixture([start], "1").reader.assertDeleted([boundary])).rejects.toThrow("history");
    await expect(fixture([start], "0", 1).reader.assertDeleted([boundary])).rejects.toThrow(
      "partition",
    );
  });
  it("rejects skipped offsets and regressing or incomplete lifecycle transitions", async () => {
    await expect(
      fixture([start, update(2), update(3)], "0", 0, ["0", "2", "3"]).reader.assertDeleted([
        boundary,
      ]),
    ).rejects.toThrow("history");
    for (const values of [
      [start, update(3)],
      [start, update(2), update(1)],
    ]) {
      await expect(fixture(values).reader.assertDeleted([boundary])).rejects.toThrow("lifecycle");
    }
  });
  it("allows unexpired copied segments and rejects an unknown topic generation", async () => {
    await expect(
      fixture([start, update(1)]).reader.assertDeleted([{ ...boundary, offset: "0" }]),
    ).resolves.toBeInstanceOf(Map);
    await expect(
      fixture([start]).reader.assertDeleted([{ ...boundary, topicId: "AAAAAAAAAAAAAAAAAAAAAQ" }]),
    ).rejects.toThrow("generation");
  });
  it("requires every captured metadata partition to reach its cut", async () => {
    const { reader, admin, disconnect } = fixture([start, update(2), update(3)]);
    admin.fetchTopicOffsets.mockResolvedValue([
      { partition: 0, low: "0", high: "3", offset: "3" },
      { partition: 1, low: "0", high: "1", offset: "1" },
    ]);
    vi.useFakeTimers();
    try {
      const result = expect(reader.assertDeleted([boundary])).rejects.toThrow("timed out");
      await vi.runAllTimersAsync();
      await result;
      expect(disconnect).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it("closes an owned consumer on connection failure", async () => {
    const { reader, consumer, disconnect } = fixture([start]);
    vi.mocked(consumer.connect).mockRejectedValue(new Error("unavailable"));
    await expect(reader.assertDeleted([boundary])).rejects.toThrow("unavailable");
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
