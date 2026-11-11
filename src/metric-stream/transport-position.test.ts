import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MetricStreamPosition } from "./transport-position.ts";

let subject: typeof import("./transport-position.ts");
beforeEach(async () => {
  vi.resetModules();
  subject = await import("./transport-position.ts");
});

const base: MetricStreamPosition = {
  transport: "kafka",
  epoch: "epoch-1",
  topic: "metric-stream-live-v2",
  partition: 0,
  offset: "10",
};

describe("metricStreamPositionSchema", () => {
  it("accepts kafka offset positions", () => {
    expect(subject.metricStreamPositionSchema.parse(base)).toEqual(base);
  });

  it.each(["0", "123", "9223372036854775807"])(
    "accepts the canonical signed64 offset %s",
    (offset) => {
      expect(
        subject.metricStreamPositionSchema.parse({ ...base, offset, partition: 2147483647 }),
      ).toEqual({ ...base, offset, partition: 2147483647 });
    },
  );
  it.each(["", "-1", "+1", "01", "a1", "1a", " 1", "1 ", "1.5", "1e3", "9223372036854775808"])(
    "rejects noncanonical or out-of-range offset %s",
    (offset) => {
      expect(() => subject.metricStreamPositionSchema.parse({ ...base, offset })).toThrow();
    },
  );
  it.each([{ epoch: "" }, { topic: "" }, { partition: 2147483648 }, { partition: 0.5 }])(
    "rejects invalid stream identity %j",
    (invalid) => {
      expect(() => subject.metricStreamPositionSchema.parse({ ...base, ...invalid })).toThrow();
    },
  );
  it("rejects unexpected coordinate fields", () => {
    expect(() => subject.metricStreamPositionSchema.parse({ ...base, extra: "unbound" })).toThrow();
  });
  it("rejects non-kafka transport coordinates", () => {
    expect(() =>
      subject.metricStreamPositionSchema.parse({
        ...base,
        transport: "pulsar",
      }),
    ).toThrow();
  });

  it("rejects negative offsets and partitions", () => {
    expect(() => subject.metricStreamPositionSchema.parse({ ...base, offset: "-1" })).toThrow();
    expect(() => subject.metricStreamPositionSchema.parse({ ...base, partition: -1 })).toThrow();
  });
});

describe("compareMetricStreamPositions", () => {
  it("validates both inputs before comparing coordinates", () => {
    expect(() => subject.compareMetricStreamPositions({ ...base, offset: "01" }, base)).toThrow();
    expect(() => subject.compareMetricStreamPositions(base, { ...base, offset: "01" })).toThrow();
  });
  it("orders by offset on the same topic partition", () => {
    expect(subject.compareMetricStreamPositions(base, { ...base, offset: "11" })).toBe(-1);
    expect(subject.compareMetricStreamPositions({ ...base, offset: "11" }, base)).toBe(1);
    expect(subject.compareMetricStreamPositions(base, { ...base })).toBe(0);
    expect(subject.compareMetricStreamPositions({ ...base, offset: "9" }, base)).toBe(-1);
    expect(subject.compareMetricStreamPositions(base, { ...base, offset: "9" })).toBe(1);
  });

  it("fails closed across epoch, topic, or partition mismatches", () => {
    expect(() => subject.compareMetricStreamPositions(base, { ...base, epoch: "other" })).toThrow(
      /share epoch, topic, and partition/,
    );
    expect(() =>
      subject.compareMetricStreamPositions(base, { ...base, topic: "metric-stream-history-v2" }),
    ).toThrow(/share epoch, topic, and partition/);
    expect(() => subject.compareMetricStreamPositions(base, { ...base, partition: 1 })).toThrow(
      /share epoch, topic, and partition/,
    );
  });
});
