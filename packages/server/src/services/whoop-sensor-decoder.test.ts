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
    expect(result.fields).toEqual(
      expect.arrayContaining([
        { label: "Skin temperature word", value: 3218, unit: "raw" },
        { label: "Thermal channel A", value: 294, unit: "raw" },
        { label: "Motion counter", value: 65231, unit: "raw" },
      ]),
    );
  });

  it("rejects corrupted records before interpreting plausible thermal bytes", () => {
    const bytes = Buffer.from(capturedFrames[0] ?? "", "hex");
    bytes[73] ^= 1;
    expect(() => decodeWhoopSensorRecord({ ...record, frameHex: bytes.toString("hex") })).toThrow(
      /CRC/,
    );
  });

  it("rejects a valid frame followed by unvalidated trailing bytes", () => {
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
