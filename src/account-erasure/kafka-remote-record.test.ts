import { describe, expect, it } from "vitest";
import { decodeKafkaRemoteRecord } from "./kafka-remote-record.ts";

// Kafka 4.4 RemoteLogSegmentMetadataRecord v0; native formatter parity is a release gate.
const identity =
  "0873616d706c6573748d8ee87556424b82ed7812cbb709df00000000000000000000000000000000000000000100";
const started = Buffer.from(
  [
    "010000",
    identity,
    "0000000000000000",
    "0000000000000063",
    "00000001",
    "0000000000000000",
    "0000000000000064",
    "02",
    "00000000",
    "0000000000000000",
    "00",
    "00000400",
    "00",
    "00",
    "00",
  ].join(""),
  "hex",
);
const deleted = Buffer.from(`010100${identity}000000010000000000000065000300`, "hex");

describe("pinned Kafka remote metadata records", () => {
  it("reads native segment admission and its offset range", () => {
    expect(decodeKafkaRemoteRecord(started)).toEqual({
      topic: "samples",
      topicId: "dI2O6HVWQkuC7XgSy7cJ3w",
      partition: 0,
      segmentId: "AAAAAAAAAAAAAAAAAAAAAQ",
      startOffset: "0",
      endOffset: "99",
      state: 0,
    });
  });
  it("reads delete-finished without inventing a start offset", () => {
    expect(decodeKafkaRemoteRecord(deleted)).toEqual({
      topic: "samples",
      topicId: "dI2O6HVWQkuC7XgSy7cJ3w",
      partition: 0,
      segmentId: "AAAAAAAAAAAAAAAAAAAAAQ",
      state: 3,
    });
  });
  it("rejects every truncated prefix of native admission and update records", () => {
    for (const record of [started, deleted])
      for (let end = 0; end < record.length; end++) {
        expect(() => decodeKafkaRemoteRecord(record.subarray(0, end))).toThrow();
      }
  });
  it("accepts opaque native custom metadata and the known transaction-index tag", () => {
    const custom = Buffer.concat([
      deleted.subarray(0, -3),
      Buffer.from([4]),
      Buffer.from("abc"),
      Buffer.from([3, 0]),
    ]);
    expect(decodeKafkaRemoteRecord(custom).state).toBe(3);
    const tagged = Buffer.concat([started.subarray(0, -1), Buffer.from([1, 0, 1, 1])]);
    expect(decodeKafkaRemoteRecord(tagged).startOffset).toBe("0");
  });
  it("preserves offsets beyond JavaScript's integer precision", () => {
    const bytes = Buffer.from(started);
    const position = 3 + identity.length / 2;
    bytes.writeBigInt64BE(9007199254740993n, position);
    bytes.writeBigInt64BE(9007199254740994n, position + 8);
    expect(decodeKafkaRemoteRecord(bytes)).toMatchObject({
      startOffset: "9007199254740993",
      endOffset: "9007199254740994",
    });
  });
  it("rejects negative/reversed ranges, invalid states and unsupported tagged fields", () => {
    const position = 3 + identity.length / 2;
    for (const [start, end] of [
      [-1n, 99n],
      [100n, 99n],
    ] as const) {
      const bytes = Buffer.from(started);
      bytes.writeBigInt64BE(start, position);
      bytes.writeBigInt64BE(end, position + 8);
      expect(() => decodeKafkaRemoteRecord(bytes)).toThrow("range");
    }
    const state = Buffer.from(deleted);
    state[state.length - 2] = 255;
    expect(() => decodeKafkaRemoteRecord(state)).toThrow("state");
    for (const tags of [
      [1, 1, 1, 1],
      [1, 0, 1, 2],
      [2, 0, 1, 1, 0, 1, 1],
    ]) {
      expect(() =>
        decodeKafkaRemoteRecord(Buffer.concat([started.subarray(0, -1), Buffer.from(tags)])),
      ).toThrow("tag");
    }
  });
  it.each([
    Buffer.alloc(0),
    started.subarray(0, -1),
    Buffer.concat([deleted, Buffer.from([0])]),
    Buffer.from([2, 0, 0]),
    Buffer.from([1, 4, 0]),
    Buffer.from([1, 0, 1]),
  ])("rejects incomplete, unknown or trailing native bytes %s", (bytes) => {
    expect(() => decodeKafkaRemoteRecord(bytes)).toThrow();
  });
});
