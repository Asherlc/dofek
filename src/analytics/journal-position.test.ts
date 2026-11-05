import { describe, expect, it } from "vitest";
import { assertPositionStream, metricStreamPositionIdentity } from "./journal-position.ts";

describe("delivery stream positions", () => {
  const stream = { transport: "kafka" as const, epoch: "epoch", topic: "sensor", partition: 0 };
  const position = { ...stream, offset: "9007199254740993" };
  it("retains lossless delivery identity", () =>
    expect(metricStreamPositionIdentity(position)).toBe("9007199254740993"));
  it("rejects positions from another stream", () => {
    expect(() => assertPositionStream(position, { ...stream, epoch: "other" })).toThrow();
  });
});
