import { describe, expect, it } from "vitest";
import {
  compareMetricStreamPositions,
  kafkaMetricStreamPositionSchema,
  type MetricStreamPosition,
} from "./transport-position.ts";

const base: MetricStreamPosition = {
  transport: "kafka",
  epoch: "epoch-1",
  topic: "metric-stream-live-v2",
  partition: 0,
  offset: "10",
};

describe("kafkaMetricStreamPositionSchema", () => {
  it("accepts kafka offset positions", () => {
    expect(kafkaMetricStreamPositionSchema.parse(base)).toEqual(base);
  });

  it("rejects pulsar delivery coordinates", () => {
    expect(() =>
      kafkaMetricStreamPositionSchema.parse({
        transport: "pulsar",
        epoch: "epoch-1",
        topic: "persistent://public/default/sensor",
        partition: -1,
        delivery: { major: "1", minor: "0", batch: -1 },
      }),
    ).toThrow();
  });

  it("rejects negative offsets and partitions", () => {
    expect(() => kafkaMetricStreamPositionSchema.parse({ ...base, offset: "-1" })).toThrow();
    expect(() => kafkaMetricStreamPositionSchema.parse({ ...base, partition: -1 })).toThrow();
  });
});

describe("compareMetricStreamPositions", () => {
  it("orders by offset on the same topic partition", () => {
    expect(compareMetricStreamPositions(base, { ...base, offset: "11" })).toBe(-1);
    expect(compareMetricStreamPositions({ ...base, offset: "11" }, base)).toBe(1);
    expect(compareMetricStreamPositions(base, { ...base })).toBe(0);
  });

  it("fails closed across epoch, topic, or partition mismatches", () => {
    expect(() => compareMetricStreamPositions(base, { ...base, epoch: "other" })).toThrow(
      /share epoch, topic, and partition/,
    );
    expect(() =>
      compareMetricStreamPositions(base, { ...base, topic: "metric-stream-history-v2" }),
    ).toThrow(/share epoch, topic, and partition/);
    expect(() => compareMetricStreamPositions(base, { ...base, partition: 1 })).toThrow(
      /share epoch, topic, and partition/,
    );
  });
});
