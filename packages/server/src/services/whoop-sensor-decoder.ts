import { crc32 } from "node:zlib";
import {
  type WhoopSensorReading,
  type WhoopSensorRecord,
  whoopSensorRecordSchema,
} from "@dofek/providers/whoop-sensors";

/** Validate the complete wire frame before reading any versioned fields. */
export function decodeWhoopSensorRecord(input: WhoopSensorRecord): WhoopSensorReading {
  const record = whoopSensorRecordSchema.parse(input);
  const frame = Buffer.from(record.frameHex, "hex");
  if (
    frame.length < 14 ||
    frame[0] !== 0xaa ||
    frame[1] !== 1 ||
    frame.readUInt16LE(2) + 8 !== frame.length
  ) {
    throw new Error("WHOOP sensor frame length or format is invalid");
  }
  let headerCrc = 0xffff;
  for (const byte of frame.subarray(0, 6)) {
    headerCrc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      headerCrc = (headerCrc & 1) !== 0 ? (headerCrc >>> 1) ^ 0xa001 : headerCrc >>> 1;
  }
  if (
    headerCrc !== frame.readUInt16LE(6) ||
    crc32(frame.subarray(8, -4)) !== frame.readUInt32LE(frame.length - 4)
  ) {
    throw new Error("WHOOP sensor frame CRC is invalid");
  }
  const packetType = frame.readUInt8(8);
  const layout = frame.readUInt8(9);
  if (![43, 47].includes(packetType) || layout === 16 || layout === 17 || layout === 21) {
    throw new Error("WHOOP frame is not an additional background sensor record");
  }
  const result: WhoopSensorReading = {
    captureId: record.captureId,
    receivedAt: record.timestamp,
    measuredAt: null,
    packetType,
    layout,
    skinTemperatureC: null,
    fields: [],
    rawFrameHex: record.frameHex,
    deviceInfo: record.deviceInfo,
    interpretation: "Raw record; sensor layout and physical units are unverified.",
  };
  // R18 mapping corroborated by the 71 CRC-valid original PacketLogger frames.
  // Full-frame offsets; do not apply WHOOP 4 layouts or interpret unknown tails.
  if (packetType === 47 && layout === 18 && frame.length === 124 && frame[10] === 0x80) {
    const seconds = frame.readUInt32LE(15);
    const fractions = frame.readUInt16LE(19);
    const thermalWord = frame.readUInt16LE(73);
    const temperature = thermalWord / 100;
    result.measuredAt = new Date(Math.round((seconds + fractions / 32_768) * 1000)).toISOString();
    result.skinTemperatureC = temperature >= 5 && temperature <= 45 ? temperature : null;
    result.fields = [
      { label: "Skin temperature word", value: thermalWord, unit: "raw" },
      { label: "Thermal channel A", value: frame.readInt16LE(69), unit: "raw" },
      { label: "Thermal channel B", value: frame.readInt16LE(71), unit: "raw" },
      { label: "Motion counter", value: frame.readUInt16LE(57), unit: "raw" },
      { label: "Cadence word", value: frame.readUInt16LE(59), unit: "raw" },
      { label: "Activity code", value: frame.readUInt8(63), unit: "raw" },
      { label: "Cardiac flags", value: frame.readUInt8(36), unit: "raw" },
      { label: "Band state", value: frame.readUInt8(81), unit: "raw" },
    ];
    result.interpretation =
      "Capture-backed R18 encoding; temperature calibration and raw status meanings are unverified.";
  }
  return result;
}
