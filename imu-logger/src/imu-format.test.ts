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
  const accelSample: ImuSample = { tMs: 100, ax: 1.5, ay: -2.5, az: 9.81 };
  const gyroSample: ImuSample = { ...accelSample, gx: 0.1, gy: -0.2, gz: 0.3 };

  it("encodes sample count in first 2 bytes", () => {
    const buf = encodeChunk([accelSample, accelSample], false);
    const view = new DataView(buf);
    expect(view.getUint16(0, true)).toBe(2);
  });

  it("leaves 2 reserved bytes after count", () => {
    const buf = encodeChunk([accelSample], false);
    const view = new DataView(buf);
    expect(view.getUint16(2, true)).toBe(0);
  });

  it("encodes accel-only records at 16 bytes each", () => {
    const buf = encodeChunk([accelSample], false);
    expect(buf.byteLength).toBe(4 + 16);
  });

  it("encodes gyro records at 28 bytes each", () => {
    const buf = encodeChunk([gyroSample], true);
    expect(buf.byteLength).toBe(4 + 28);
  });

  it("encodes fields in order: tMs, ax, ay, az", () => {
    const buf = encodeChunk([accelSample], false);
    const view = new DataView(buf);
    // Record layout: tMs(4) + ax(4) + ay(4) + az(4)
    const recordOffset = 4;
    expect(view.getUint32(recordOffset + 0, true)).toBe(100);
    expect(view.getFloat32(recordOffset + 4, true)).toBe(1.5);
    expect(view.getFloat32(recordOffset + 8, true)).toBe(-2.5);
    expect(view.getFloat32(recordOffset + 12, true)).toBeCloseTo(9.81, 4);
  });

  it("encodes gyroscope fields after accel", () => {
    const buf = encodeChunk([gyroSample], true);
    const view = new DataView(buf);
    // Record layout: tMs(4) + ax(4) + ay(4) + az(4) + gx(4) + gy(4) + gz(4)
    const recordOffset = 4;
    expect(view.getUint32(recordOffset + 0, true)).toBe(100);
    expect(view.getFloat32(recordOffset + 4, true)).toBe(1.5);
    expect(view.getFloat32(recordOffset + 16, true)).toBeCloseTo(0.1, 4);
    expect(view.getFloat32(recordOffset + 20, true)).toBeCloseTo(-0.2, 4);
    expect(view.getFloat32(recordOffset + 24, true)).toBeCloseTo(0.3, 4);
  });

  it("uses 0 for missing gyro fields when hasGyro is true", () => {
    const sample: ImuSample = { tMs: 50, ax: 1, ay: 2, az: 3 };
    const buf = encodeChunk([sample], true);
    const view = new DataView(buf);
    const recordOffset = 4;
    expect(view.getUint32(recordOffset + 0, true)).toBe(50);
    expect(view.getFloat32(recordOffset + 16, true)).toBe(0);
    expect(view.getFloat32(recordOffset + 20, true)).toBe(0);
    expect(view.getFloat32(recordOffset + 24, true)).toBe(0);
  });

  it("encodes multiple samples", () => {
    const samples: ImuSample[] = [
      { tMs: 0, ax: 0, ay: 0, az: 1 },
      { tMs: 100, ax: 1, ay: 2, az: 3 },
      { tMs: 200, ax: 4, ay: 5, az: 6 },
    ];
    const buf = encodeChunk(samples, false);
    const view = new DataView(buf);
    expect(view.getUint16(0, true)).toBe(3);
    expect(buf.byteLength).toBe(4 + 3 * 16);
    // Third record (index 2) starts at offset 4 + 2*16
    expect(view.getUint32(4 + 2 * 16, true)).toBe(200);
  });

  it("returns buffer with count=0 for empty samples", () => {
    const buf = encodeChunk([], false);
    const view = new DataView(buf);
    expect(view.getUint16(0, true)).toBe(0);
    expect(buf.byteLength).toBe(4);
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

describe("binary roundtrip", () => {
  it("header → patch → encodeChunk produces a valid stream", () => {
    const header = createHeader({
      hasGyro: true,
      sessionStartMs: 1000,
      sampleCount: 0,
      accelFreqMode: 2,
      gyroFreqMode: 2,
      observedHzX100: 2600,
    });

    expect(header.byteLength).toBe(HEADER_SIZE);

    const samples: ImuSample[] = [
      { tMs: 0, ax: 0.5, ay: -0.5, az: 9.8, gx: 0.01, gy: 0.02, gz: 0.03 },
      { tMs: 100, ax: 1.0, ay: -1.0, az: 9.7, gx: 0.04, gy: 0.05, gz: 0.06 },
    ];

    const chunk = encodeChunk(samples, true);
    expect(chunk.byteLength).toBe(4 + 2 * 28);

    const patched = patchHeaderSampleCount(header, 2, 2600);
    const parsed = parseHeader(patched);
    expect(parsed.sampleCount).toBe(2);
    expect(parsed.observedHzX100).toBe(2600);
  });
});
