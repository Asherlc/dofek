import { describe, expect, it } from "vitest";
import { assertPositionStream, metricStreamPositionIdentity } from "./journal-position.ts";

describe("delivery stream positions", () => {
  const stream = { transport: "kafka" as const, epoch: "epoch", topic: "sensor", partition: 0 };
  const position = { ...stream, offset: "9007199254740993" };
  it("accepts a valid position from its stream", () => {
    expect(() => assertPositionStream(position, stream)).not.toThrow();
  });
  it.each([{ epoch: "other" }, { topic: "other" }, { partition: 1 }])(
    "rejects a different stream component %j",
    (changed) => {
      expect(() => assertPositionStream(position, { ...stream, ...changed })).toThrow(
        "must share epoch, topic, and partition",
      );
    },
  );
  it.each(["-1", "01", "9223372036854775808"])("rejects invalid offset %s", (offset) => {
    expect(() => assertPositionStream({ ...position, offset }, stream)).toThrow();
  });
  it("retains lossless delivery identity", () =>
    expect(metricStreamPositionIdentity(position)).toBe("9007199254740993"));
  it("rejects positions from another stream", () => {
    expect(() => assertPositionStream(position, { ...stream, epoch: "other" })).toThrow();
  });
});
