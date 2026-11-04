import Pulsar from "pulsar-client";
import { describe, expect, it } from "vitest";
import { compareMetricStreamPositions, metricStreamPosition } from "./transport-position.ts";

const stream = { epoch: "epoch-1", topic: "persistent://public/default/sensor", partition: 2 };

// Native C++ 4.2.0 MessageIdData protobuf fixtures; each fixture passes through
// the real pinned native client, including its lossless string and serializer.
function nativeId(hex: string) {
  return MessageId.deserialize(Buffer.from(hex, "hex"));
}

describe("native metric stream position", () => {
  it("preservesLargeNativeCoordinates", () => {
    const id = nativeId("08818080808080801010828080808080801018022003");
    const position = metricStreamPosition(stream, id);
    expect(position.delivery).toEqual({
      major: "9007199254740993",
      minor: "9007199254740994",
      batch: 3,
    });
    expect(Buffer.from(position.serializedMessageId, "base64")).toEqual(id.serialize());
    expect(
      MessageId.deserialize(Buffer.from(position.serializedMessageId, "base64")).toString(),
    ).toBe("(9007199254740993,9007199254740994,2,3)");
  });

  it("ordersBatchedMessagesAcrossLedgerRollover", () => {
    const positions = ["080a10e70718022001", "080a10e70718022002", "080b100018022000"].map((hex) =>
      metricStreamPosition(stream, nativeId(hex)),
    );
    const [first, second, third] = positions;
    if (!first || !second || !third) throw new Error("Missing native fixture");
    expect(compareMetricStreamPositions(first, second)).toBe(-1);
    expect(compareMetricStreamPositions(second, third)).toBe(-1);
    expect(compareMetricStreamPositions(third, first)).toBe(1);
    expect(compareMetricStreamPositions(first, first)).toBe(0);
  });

  it("rejectsComparisonAcrossEpochOrPartition", () => {
    const id = nativeId("080a100018022000");
    const position = metricStreamPosition(stream, id);
    expect(() => compareMetricStreamPositions(position, { ...position, epoch: "epoch-2" })).toThrow(
      /stream/i,
    );
    expect(() => compareMetricStreamPositions(position, { ...position, partition: 3 })).toThrow(
      /stream/i,
    );
    expect(() => compareMetricStreamPositions(position, { ...position, topic: "other" })).toThrow(
      /stream/i,
    );
    expect(() => metricStreamPosition({ ...stream, partition: 3 }, id)).toThrow(/partition/i);
  });

  it("rejectsUnknownNativeRepresentation", () => {
    const id = nativeId("080a100018022000");
    expect(() =>
      metricStreamPosition(stream, { serialize: () => id.serialize(), toString: () => "unknown" }),
    ).toThrow(/representation/i);
    expect(() => metricStreamPosition(stream, MessageId.earliest())).toThrow(/representation/i);
    expect(() => metricStreamPosition(stream, MessageId.latest())).toThrow(/partition/i);
    expect(() => metricStreamPosition({ ...stream, partition: -1 }, MessageId.latest())).toThrow(
      /sentinel|representation/i,
    );
    expect(() =>
      metricStreamPosition(stream, {
        serialize: () => id.serialize(),
        toString: () => "(1,2,2,0);(2,3,2,0)",
      }),
    ).toThrow(/representation/i);
  });
});

const { MessageId } = Pulsar;
