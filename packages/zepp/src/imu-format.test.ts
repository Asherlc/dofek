import { describe, expect, it } from "vitest";
import {
  concatArrayBuffers,
  createHeader,
  encodeChunk,
  FLAG_HAS_GYRO,
  FORMAT_VERSION,
  HEADER_SIZE,
  MAGIC,
  patchHeaderSampleCount,
} from "./imu-format.ts";
import type { ImuSample } from "./types.ts";

function parseHeader(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  return {
    magic: view.getUint32(0, true),
    version: view.getUint8(4),
    flags: view.getUint8(5),
    reserved: view.getUint16(6, true),
    sessionStartMs: view.getUint32(8, true) + view.getUint32(12, true) * 0x100000000,
    sampleCount: view.getUint32(16, true),
    accelFreqMode: view.getUint8(20),
    gyroFreqMode: view.getUint8(21),
    observedHzX100: view.getUint16(22, true),
  };
}

describe("createHeader", () => {
  it("writes magic and version", () => {
    const buf = createHeader({});
    const parsed = parseHeader(buf);
    expect(parsed.magic).toBe(MAGIC);
    expect(parsed.version).toBe(FORMAT_VERSION);
  });

  it("defaults to accel-only mode", () => {
    const buf = createHeader({});
    const parsed = parseHeader(buf);
    expect(parsed.flags).toBe(0);
    expect(parsed.gyroFreqMode).toBe(0);
  });

  it("sets FLAG_HAS_GYRO and gyro freq when gyro enabled", () => {
    const buf = createHeader({ hasGyro: true, gyroFreqMode: 2 });
    const parsed = parseHeader(buf);
    expect(parsed.flags).toBe(FLAG_HAS_GYRO);
    expect(parsed.gyroFreqMode).toBe(2);
  });

  it("stores sessionStartMs", () => {
    const buf = createHeader({ sessionStartMs: 1234567890 });
    const parsed = parseHeader(buf);
    expect(parsed.sessionStartMs).toBe(1234567890);
  });

  it("stores large sessionStartMs (>uint32) without truncation", () => {
    const large = Date.now();
    const buf = createHeader({ sessionStartMs: large });
    const parsed = parseHeader(buf);
    expect(parsed.sessionStartMs).toBe(large);
  });

  it("stores sampleCount", () => {
    const buf = createHeader({ sampleCount: 99999 });
    const parsed = parseHeader(buf);
    expect(parsed.sampleCount).toBe(99999);
  });

  it("stores accel freq mode", () => {
    const buf = createHeader({ accelFreqMode: 2 });
    const parsed = parseHeader(buf);
    expect(parsed.accelFreqMode).toBe(2);
  });

  it("stores observed Hz × 100", () => {
    const buf = createHeader({ observedHzX100: 2600 });
    const parsed = parseHeader(buf);
    expect(parsed.observedHzX100).toBe(2600);
  });

  it("produces exactly HEADER_SIZE bytes", () => {
    const buf = createHeader({});
    expect(buf.byteLength).toBe(HEADER_SIZE);
  });
});

describe("patchHeaderSampleCount", () => {
  it("updates sampleCount in an existing header", () => {
    const buf = createHeader({ sampleCount: 0 });
    const patched = patchHeaderSampleCount(buf.slice(0), 500, 2500);
    const parsed = parseHeader(patched);
    expect(parsed.sampleCount).toBe(500);
    expect(parsed.observedHzX100).toBe(2500);
  });

  it("does not change observedHzX100 when omitted", () => {
    const buf = createHeader({ observedHzX100: 1000 });
    const patched = patchHeaderSampleCount(buf.slice(0), 100);
    const parsed = parseHeader(patched);
    expect(parsed.observedHzX100).toBe(1000);
    expect(parsed.sampleCount).toBe(100);
  });

  it("returns the same buffer reference", () => {
    const buf = createHeader({});
    const patched = patchHeaderSampleCount(buf, 10, 100);
    expect(patched).toBe(buf);
  });
});

describe("encodeChunk", () => {
  it("encodes independent vectors using tagged twenty-byte records", () => {
    const samples: ImuSample[] = [
      { tMs: 10, sensor: "accelerometer", x: 1, y: -2, z: 3 },
      { tMs: 12, sensor: "gyroscope", x: 4, y: 5, z: 6 },
    ];
    const chunk = encodeChunk(samples);
    const view = new DataView(chunk);
    expect(chunk.byteLength).toBe(44);
    expect(view.getUint16(0, true)).toBe(2);
    expect(view.getUint32(4, true)).toBe(10);
    expect(view.getUint32(8, true)).toBe(0);
    expect(view.getFloat32(12, true)).toBe(1);
    expect(view.getFloat32(16, true)).toBe(-2);
    expect(view.getFloat32(20, true)).toBe(3);
    expect(view.getUint32(24, true)).toBe(12);
    expect(view.getUint32(28, true)).toBe(1);
    expect(view.getFloat32(32, true)).toBe(4);
    expect(view.getFloat32(36, true)).toBe(5);
    expect(view.getFloat32(40, true)).toBe(6);
  });
  it("rejects out-of-range timestamps and chunk counts", () => {
    expect(() => encodeChunk([{ tMs: -1, sensor: "accelerometer", x: 1, y: 2, z: 3 }])).toThrow(
      "timestamp",
    );
    expect(() =>
      encodeChunk(
        Array.from({ length: 65536 }, () => ({
          tMs: 0,
          sensor: "accelerometer",
          x: 1,
          y: 2,
          z: 3,
        })),
      ),
    ).toThrow("65535");
  });
});

describe("concatArrayBuffers", () => {
  it("merges multiple buffers", () => {
    const bufA = new Uint8Array([1, 2, 3]).buffer;
    const bufB = new Uint8Array([4, 5]).buffer;
    const merged = concatArrayBuffers([bufA, bufB]);
    expect(new Uint8Array(merged)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it("returns empty buffer for empty input", () => {
    const merged = concatArrayBuffers([]);
    expect(merged.byteLength).toBe(0);
  });

  it("handles single buffer", () => {
    const buf = new Uint8Array([42]).buffer;
    const merged = concatArrayBuffers([buf]);
    expect(new Uint8Array(merged)).toEqual(new Uint8Array([42]));
  });
});
