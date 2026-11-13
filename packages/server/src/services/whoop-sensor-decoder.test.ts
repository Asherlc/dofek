import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeWhoopSensorRecord } from "./whoop-sensor-decoder.ts";

// Original repository PacketLogger capture, not a generated physiological fixture.
const capturedFrames = readFileSync(
  new URL(
    "../../../mobile/modules/whoop-ble/Tests/fixtures/imu-activation-capture.tsv",
    import.meta.url,
  ),
  "utf8",
)
  .split("\n")
  .map((line) => line.split("\t").at(-1) ?? "")
  .filter((hex) => hex.length === 248 && hex.slice(16, 20) === "2f12");
const record = {
  captureId: "1087b7ac-fc32-4c29-8b31-72e366dc974d",
  timestamp: "2026-10-30T12:00:00.000Z",
  deviceInfo: {},
};

// Constructed envelopes exercise validation/dispatch only, never establish a sensor map.
function constructedFrame(length: number, mutate: (frame: Buffer) => void = () => {}) {
  const frame = Buffer.alloc(length);
  Buffer.from(capturedFrames[0] ?? "", "hex").copy(frame);
  frame.writeUInt16LE(length - 8, 2);
  mutate(frame);
  let checksum = 0xffff;
  for (const byte of frame.subarray(0, 6)) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit++)
      checksum = (checksum & 1) !== 0 ? (checksum >>> 1) ^ 0xa001 : checksum >>> 1;
  }
  frame.writeUInt16LE(checksum, 6);
  frame.writeUInt32LE(crc32(frame.subarray(8, -4)), length - 4);
  return frame.toString("hex");
}

describe("decodeWhoopSensorRecord", () => {
  it("decodes captured R18 thermal words and keeps delayed receipt separate from source time", () => {
    expect(capturedFrames).toHaveLength(71);
    const result = decodeWhoopSensorRecord({ ...record, frameHex: capturedFrames[0] ?? "" });
    expect(result).toMatchObject({
      packetType: 47,
      layout: 18,
      receivedAt: record.timestamp,
      measuredAt: "2026-03-29T15:28:11.430Z",
      skinTemperatureC: 32.18,
    });
    expect(result.fields).toEqual([
      { label: "Skin temperature word", value: 3218, unit: "raw" },
      { label: "Thermal channel A", value: 294, unit: "raw" },
      { label: "Thermal channel B", value: 307, unit: "raw" },
      { label: "Motion counter", value: 65231, unit: "raw" },
      { label: "Cadence word", value: 144, unit: "raw" },
      { label: "Activity code", value: 0, unit: "raw" },
      { label: "Cardiac flags", value: 140, unit: "raw" },
      { label: "Band state", value: 0, unit: "raw" },
    ]);
  });

  it.each([12, 13])("rejects a CRC-valid envelope below minimum length: %i", (length) => {
    expect(() =>
      decodeWhoopSensorRecord({ ...record, frameHex: constructedFrame(length) }),
    ).toThrow(/length or format/);
  });

  it("accepts a minimum-size opaque sensor record", () => {
    const frameHex = constructedFrame(14, (frame) => {
      frame[8] = 43;
      frame[9] = 22;
    });
    expect(decodeWhoopSensorRecord({ ...record, frameHex })).toMatchObject({
      packetType: 43,
      layout: 22,
      skinTemperatureC: null,
      rawFrameHex: frameHex,
    });
  });

  it.each([0, 1])("rejects unsupported format byte at offset %i even with valid CRCs", (offset) => {
    const frameHex = constructedFrame(124, (frame) => {
      frame[offset] = 0;
    });
    expect(() => decodeWhoopSensorRecord({ ...record, frameHex })).toThrow(/length or format/);
  });

  it("rejects a corrupt header CRC even when the payload CRC is valid", () => {
    const frame = Buffer.from(capturedFrames[0] ?? "", "hex");
    frame[6] ^= 1;
    expect(() => decodeWhoopSensorRecord({ ...record, frameHex: frame.toString("hex") })).toThrow(
      /CRC/,
    );
  });

  it.each([16, 17, 21])(
    "rejects excluded layout %i from the additional sensor stream",
    (layout) => {
      for (const type of [43, 47]) {
        const frameHex = constructedFrame(124, (frame) => {
          frame[8] = type;
          frame[9] = layout;
        });
        expect(() => decodeWhoopSensorRecord({ ...record, frameHex })).toThrow(
          /not an additional background sensor record/,
        );
      }
    },
  );

  it("rejects an unrelated packet type even with a full-size payload", () => {
    const frameHex = constructedFrame(124, (frame) => {
      frame[8] = 1;
    });
    expect(() => decodeWhoopSensorRecord({ ...record, frameHex })).toThrow(
      /not an additional background sensor record/,
    );
  });

  it("accepts the full realtime size boundary and rejects compact realtime data", () => {
    const frameHex = constructedFrame(65, (frame) => {
      frame[8] = 40;
    });
    expect(decodeWhoopSensorRecord({ ...record, frameHex })).toMatchObject({
      packetType: 40,
      skinTemperatureC: null,
      rawFrameHex: frameHex,
    });
    const compact = constructedFrame(64, (frame) => {
      frame[8] = 40;
    });
    expect(() => decodeWhoopSensorRecord({ ...record, frameHex: compact })).toThrow(
      /not an additional background sensor record/,
    );
  });

  it("leaves records with different R18 lengths, markers or packet types raw", () => {
    for (const frameHex of [
      constructedFrame(125),
      constructedFrame(124, (frame) => {
        frame[10] = 0;
      }),
      constructedFrame(124, (frame) => {
        frame[8] = 43;
      }),
    ])
      expect(decodeWhoopSensorRecord({ ...record, frameHex })).toMatchObject({
        skinTemperatureC: null,
        measuredAt: null,
        fields: [],
      });
  });

  it.each<[number, number | null]>([
    [499, null],
    [500, 5],
    [4500, 45],
    [4501, null],
  ])("bounds the thermal projection for raw word %i", (word, temperature) => {
    const frameHex = constructedFrame(124, (frame) => {
      frame.writeUInt16LE(word, 73);
    });
    const result = decodeWhoopSensorRecord({ ...record, frameHex });
    expect(result.skinTemperatureC).toBe(temperature);
    expect(result.fields[0]).toEqual({ label: "Skin temperature word", value: word, unit: "raw" });
  });

  it("rejects corrupted records before interpreting plausible thermal bytes", () => {
    const bytes = Buffer.from(capturedFrames[0] ?? "", "hex");
    bytes[73] ^= 1;
    expect(() => decodeWhoopSensorRecord({ ...record, frameHex: bytes.toString("hex") })).toThrow(
      /CRC/,
    );
  });

  it("rejects a valid frame followed by unchecked trailing bytes", () => {
    expect(() =>
      decodeWhoopSensorRecord({ ...record, frameHex: `${capturedFrames[0]}00` }),
    ).toThrow(/length/);
  });

  it("retains an unknown sensor layout without inventing temperature or measurement time", () => {
    // Constructed layout selector mutation tests dispatch, not a new sensor map.
    const frame = Buffer.from(capturedFrames[0] ?? "", "hex");
    frame[9] = 22;
    frame.writeUInt32LE(crc32(frame.subarray(8, -4)), frame.length - 4);
    expect(decodeWhoopSensorRecord({ ...record, frameHex: frame.toString("hex") })).toMatchObject({
      layout: 22,
      measuredAt: null,
      skinTemperatureC: null,
      fields: [],
      rawFrameHex: frame.toString("hex"),
    });
  });

  it("preserves a full realtime transport without interpreting its opaque optical bytes", () => {
    const frame = Buffer.from(capturedFrames[0] ?? "", "hex");
    frame[8] = 40;
    frame.writeUInt32LE(crc32(frame.subarray(8, -4)), frame.length - 4);
    expect(decodeWhoopSensorRecord({ ...record, frameHex: frame.toString("hex") })).toMatchObject({
      packetType: 40,
      measuredAt: null,
      skinTemperatureC: null,
      fields: [],
      rawFrameHex: frame.toString("hex"),
    });
  });

  it("decodes every complete captured R18 frame without consuming the CRC trailer", () => {
    const readings = capturedFrames.map((frameHex) =>
      decodeWhoopSensorRecord({ ...record, frameHex }),
    );
    expect(
      readings.every(
        (reading) =>
          reading.skinTemperatureC !== null &&
          reading.skinTemperatureC >= 32.16 &&
          reading.skinTemperatureC <= 32.22,
      ),
    ).toBe(true);
  });
});
