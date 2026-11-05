import Pulsar from "pulsar-client";
import { describe, expect, it } from "vitest";
import {
  compareMetricStreamPositions,
  metricStreamPosition,
  metricStreamPositionSchema,
} from "./transport-position.ts";

const stream = { epoch: "epoch-1", topic: "persistent://public/default/sensor", partition: 2 };

// Native C++ 4.2.0 MessageIdData protobuf fixtures; each fixture passes through
// the real pinned native client, including its lossless string and serializer.
function nativeId(hex: string) {
  return MessageId.deserialize(Buffer.from(hex, "hex"));
}

describe("native metric stream position", () => {
  it("orders Kafka positions equally and in both directions without rounding", () => {
    const left = { transport: "kafka" as const, ...stream, offset: "9007199254740993" };
    const right = { ...left, offset: "9007199254740994" };
    expect(compareMetricStreamPositions(left, left)).toBe(0);
    expect(compareMetricStreamPositions(left, right)).toBe(-1);
    expect(compareMetricStreamPositions(right, left)).toBe(1);
  });

  it("validates both persisted positions before comparing them", () => {
    const valid = metricStreamPosition(stream, nativeId("080a100018022000"));
    const invalid = { ...valid, serializedMessageId: "invalid" };
    expect(() => compareMetricStreamPositions(invalid, valid)).toThrow();
    expect(() => compareMetricStreamPositions(valid, invalid)).toThrow();
  });

  it("keeps real delivered coordinates distinct from the latest sentinel", () => {
    const native = metricStreamPosition(stream, nativeId("080a100018022000"));
    const maximum = "9223372036854775807";
    for (const delivery of [
      { major: maximum, minor: maximum, batch: 0 },
      { major: maximum, minor: "0", batch: -1 },
      { major: "0", minor: maximum, batch: -1 },
    ]) {
      expect(metricStreamPositionSchema.parse({ ...native, delivery })).toEqual({
        ...native,
        delivery,
      });
    }
  });

  it("accepts native int64 and int32 maxima without rounding", () => {
    const maximum = "9223372036854775807";
    const position = metricStreamPosition(
      { ...stream, partition: 2147483647 },
      {
        serialize: () => Buffer.from([1]),
        toString: () => `(${maximum},${maximum},2147483647,2147483647)`,
      },
    );
    expect(position.delivery).toEqual({ major: maximum, minor: maximum, batch: 2147483647 });
  });

  it.each(["(9223372036854775808,0,2,0)", "(0,9223372036854775808,2,0)"])(
    "reports unsupported native int64 coordinates %s",
    (representation) => {
      expect(() =>
        metricStreamPosition(stream, {
          serialize: () => Buffer.from([1]),
          toString: () => representation,
        }),
      ).toThrow(/representation: coordinates exceed int64/);
    },
  );

  it.each([
    { partition: 2, representation: "(0,0,2,2147483648)" },
    { partition: 2147483648, representation: "(0,0,2147483648,0)" },
  ])("reports unsupported native int32 coordinates $representation", (fixture) => {
    expect(() =>
      metricStreamPosition(
        { ...stream, partition: fixture.partition },
        { serialize: () => Buffer.from([1]), toString: () => fixture.representation },
      ),
    ).toThrow(/representation: coordinates exceed int32/);
  });

  it.each(["", "-1", "01", "+1", "1.5", "1x", "9223372036854775808"])(
    "rejects invalid persisted coordinates %j",
    (coordinate) => {
      const native = metricStreamPosition(stream, nativeId("080a100018022000"));
      for (const field of ["major", "minor"] as const) {
        expect(() =>
          metricStreamPositionSchema.parse({
            ...native,
            delivery: { ...native.delivery, [field]: coordinate },
          }),
        ).toThrow();
      }
      expect(() =>
        metricStreamPositionSchema.parse({ transport: "kafka", ...stream, offset: coordinate }),
      ).toThrow();
    },
  );

  it.each(["", "A", "AA", "AA=", "AA===", "AAAA=", "!AAA", "AAAA\n"])(
    "rejects an invalid serialized native identity %j",
    (serializedMessageId) => {
      const native = metricStreamPosition(stream, nativeId("080a100018022000"));
      expect(() => metricStreamPositionSchema.parse({ ...native, serializedMessageId })).toThrow();
    },
  );

  it("accepts the full native coordinate domain and compares entry IDs before batch IDs", () => {
    const native = metricStreamPosition(stream, nativeId("080a100018022000"));
    for (const serializedMessageId of ["AA==", "AAA=", "AAAA"]) {
      expect(metricStreamPositionSchema.parse({ ...native, serializedMessageId })).toEqual({
        ...native,
        serializedMessageId,
      });
    }
    const first = { ...native, delivery: { major: "9223372036854775807", minor: "0", batch: 5 } };
    const second = { ...first, delivery: { ...first.delivery, minor: "1", batch: -1 } };
    expect(compareMetricStreamPositions(first, second)).toBe(-1);
    expect(compareMetricStreamPositions(second, first)).toBe(1);
    expect(
      metricStreamPositionSchema.parse({
        ...first,
        partition: 2147483647,
        delivery: { major: "0", minor: "9223372036854775807", batch: 2147483647 },
      }),
    ).toMatchObject({ partition: 2147483647 });
  });

  it.each([
    { epoch: "" },
    { topic: "" },
    { partition: -2 },
    { partition: 0.5 },
    { partition: 2147483648 },
  ])("rejects an invalid stream descriptor %j", (invalid) => {
    const native = metricStreamPosition(stream, nativeId("080a100018022000"));
    expect(() => metricStreamPositionSchema.parse({ ...native, ...invalid })).toThrow();
    expect(() =>
      metricStreamPosition({ ...stream, ...invalid }, nativeId("080a100018022000")),
    ).toThrow();
  });

  it.each([-2, 0.5, 2147483648])("rejects an invalid persisted batch index %j", (batch) => {
    const native = metricStreamPosition(stream, nativeId("080a100018022000"));
    expect(() =>
      metricStreamPositionSchema.parse({ ...native, delivery: { ...native.delivery, batch } }),
    ).toThrow();
  });

  it.each([
    "(9223372036854775808,0,2,0)",
    "(0,9223372036854775808,2,0)",
    "(0,0,2,2147483648)",
    "(0,0,2147483648,0)",
    "(0,0,2,-2)",
    "(0,0,02,0)",
    "(0,0,2,00)",
  ])("rejects native coordinates outside the supported domain %s", (representation) => {
    expect(() =>
      metricStreamPosition(stream, {
        serialize: () => Buffer.from([1]),
        toString: () => representation,
      }),
    ).toThrow();
  });

  it("preservesKafkaOffsetsWithoutInventingNativeCoordinates", () => {
    const position = {
      transport: "kafka" as const,
      ...stream,
      offset: "9007199254740993",
    };
    expect(metricStreamPositionSchema.parse(position)).toEqual(position);
    expect(
      compareMetricStreamPositions(position, { ...position, offset: "9007199254740994" }),
    ).toBe(-1);
    expect(() =>
      compareMetricStreamPositions(
        position,
        metricStreamPosition(stream, nativeId("080a100018022000")),
      ),
    ).toThrow(/stream|transport/i);
  });

  it("tagsNativePositionsWithoutChangingTheirSerializedIdentity", () => {
    expect(metricStreamPosition(stream, nativeId("080a100018022000"))).toMatchObject({
      transport: "pulsar",
    });
  });
  it("rejectsMixedTransportCoordinates", () => {
    const native = metricStreamPosition(stream, nativeId("080a100018022000"));
    expect(() => metricStreamPositionSchema.parse({ ...native, offset: "42" })).toThrow();
    expect(() =>
      metricStreamPositionSchema.parse({ ...native, transport: "kafka", offset: "42" }),
    ).toThrow();
  });
  it("rejects the Kafka partition sentinel", () => {
    expect(() =>
      metricStreamPositionSchema.parse({
        transport: "kafka",
        ...stream,
        partition: -1,
        offset: "0",
      }),
    ).toThrow();
  });
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
