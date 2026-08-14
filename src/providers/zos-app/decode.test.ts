import { describe, expect, it } from "vitest";
import { decodeBin } from "./decode.ts";

function createHeader(options: {
  hasGyro?: boolean;
  sessionStartMs?: number;
  sampleCount?: number;
  accelFreqMode?: number;
  gyroFreqMode?: number;
  observedHzX100?: number;
}): ArrayBuffer {
  const buf = new ArrayBuffer(32);
  const view = new DataView(buf);
  view.setUint32(0, 0x314d5549, true);
  view.setUint8(4, 1);
  view.setUint8(5, options.hasGyro ? 1 : 0);
  view.setUint16(6, 0, true);
  const startMs = options.sessionStartMs ?? 0;
  view.setUint32(8, startMs >>> 0, true);
  view.setUint32(12, Math.floor(startMs / 0x100000000) >>> 0, true);
  view.setUint32(16, options.sampleCount ?? 0, true);
  view.setUint8(20, options.accelFreqMode ?? 1);
  view.setUint8(21, options.hasGyro ? (options.gyroFreqMode ?? 1) : 0);
  view.setUint16(22, options.observedHzX100 ?? 0, true);
  return buf;
}

function concat(...buffers: ArrayBuffer[]): ArrayBuffer {
  const total = buffers.reduce((s, b) => s + b.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const buf of buffers) {
    merged.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }
  return merged.buffer;
}

interface TestSample {
  tMs: number;
  ax: number;
  ay: number;
  az: number;
  gx?: number;
  gy?: number;
  gz?: number;
}

function encodeChunk(samples: TestSample[], hasGyro: boolean): ArrayBuffer {
  const recordSize = hasGyro ? 28 : 16;
  const buf = new ArrayBuffer(4 + samples.length * recordSize);
  const view = new DataView(buf);
  view.setUint16(0, samples.length, true);
  view.setUint16(2, 0, true);
  let offset = 4;
  for (const sample of samples) {
    view.setUint32(offset, sample.tMs, true);
    offset += 4;
    view.setFloat32(offset, sample.ax, true);
    offset += 4;
    view.setFloat32(offset, sample.ay, true);
    offset += 4;
    view.setFloat32(offset, sample.az, true);
    offset += 4;
    if (hasGyro) {
      view.setFloat32(offset, sample.gx ?? 0, true);
      offset += 4;
      view.setFloat32(offset, sample.gy ?? 0, true);
      offset += 4;
      view.setFloat32(offset, sample.gz ?? 0, true);
      offset += 4;
    }
  }
  return buf;
}

describe("decodeBin", () => {
  it("decodes an accel-only session", () => {
    const header = createHeader({
      hasGyro: false,
      sessionStartMs: 987654321,
      sampleCount: 2,
      accelFreqMode: 2,
      observedHzX100: 2600,
    });
    const samples = [
      { tMs: 0, ax: 1.0, ay: 0.5, az: -9.8 },
      { tMs: 100, ax: 1.1, ay: 0.6, az: -9.7 },
    ];
    const chunk = encodeChunk(samples, false);
    const buffer = concat(header, chunk);

    const result = decodeBin(buffer);

    expect(result.version).toBe(1);
    expect(result.hasGyro).toBe(false);
    expect(result.sessionStartMs).toBe(987654321);
    expect(result.accelFreqMode).toBe(2);
    expect(result.observedHz).toBe(26);
    expect(result.samples).toHaveLength(2);
    expect(result.samples[0]?.tMs).toBe(0);
    expect(result.samples[0]?.ax).toBeCloseTo(1.0);
    expect(result.samples[0]?.ay).toBeCloseTo(0.5);
    expect(result.samples[0]?.az).toBeCloseTo(-9.8);
    expect(result.samples[1]?.tMs).toBe(100);
    expect(result.samples[1]?.ax).toBeCloseTo(1.1);
    expect(result.samples[1]?.ay).toBeCloseTo(0.6);
    expect(result.samples[1]?.az).toBeCloseTo(-9.7);
  });

  it("decodes a session with gyro", () => {
    const header = createHeader({
      hasGyro: true,
      sessionStartMs: 987654321,
      sampleCount: 1,
      accelFreqMode: 2,
      gyroFreqMode: 1,
      observedHzX100: 2600,
    });
    const samples = [{ tMs: 50, ax: 0.0, ay: 0.1, az: -9.8, gx: 0.5, gy: -0.3, gz: 0.0 }];
    const chunk = encodeChunk(samples, true);
    const buffer = concat(header, chunk);

    const result = decodeBin(buffer);

    expect(result.hasGyro).toBe(true);
    expect(result.gyroFreqMode).toBe(1);
    expect(result.samples).toHaveLength(1);
    expect(result.samples[0]?.tMs).toBe(50);
    expect(result.samples[0]?.ax).toBeCloseTo(0.0);
    expect(result.samples[0]?.ay).toBeCloseTo(0.1);
    expect(result.samples[0]?.az).toBeCloseTo(-9.8);
    expect(result.samples[0]?.gx).toBeCloseTo(0.5);
    expect(result.samples[0]?.gy).toBeCloseTo(-0.3);
    expect(result.samples[0]?.gz).toBeCloseTo(0.0);
  });

  it("throws on invalid magic", () => {
    const buf = new ArrayBuffer(32);
    expect(() => decodeBin(buf)).toThrow("Invalid magic");
  });

  it("throws on file too small", () => {
    const buf = new ArrayBuffer(10);
    expect(() => decodeBin(buf)).toThrow("File too small");
  });

  it("handles multiple chunks", () => {
    const header = createHeader({
      hasGyro: false,
      sessionStartMs: 1_700_000_000_000,
      sampleCount: 3,
    });
    const chunk1 = encodeChunk(
      [
        { tMs: 0, ax: 1, ay: 2, az: 3 },
        { tMs: 100, ax: 4, ay: 5, az: 6 },
      ],
      false,
    );
    const chunk2 = encodeChunk([{ tMs: 200, ax: 7, ay: 8, az: 9 }], false);
    const buffer = concat(header, chunk1, chunk2);

    const result = decodeBin(buffer);

    expect(result.samples).toHaveLength(3);
    expect(result.samples[2]).toEqual({ tMs: 200, ax: 7, ay: 8, az: 9 });
  });

  it("round-trips a 64-bit epoch-ms session timestamp", () => {
    const timestamp = 1_719_300_000_000;
    const header = createHeader({
      hasGyro: false,
      sessionStartMs: timestamp,
      sampleCount: 0,
    });

    const result = decodeBin(header);

    expect(result.sessionStartMs).toBe(timestamp);
  });

  it("throws on truncated chunk", () => {
    const header = createHeader({
      hasGyro: false,
      sampleCount: 5,
    });
    const chunk = encodeChunk([{ tMs: 0, ax: 1, ay: 2, az: 3 }], false);
    const chunkView = new DataView(chunk);
    chunkView.setUint16(0, 10, true);
    const buffer = concat(header, chunk);

    expect(() => decodeBin(buffer)).toThrow("declared 10 samples but only 1");
  });

  it("handles empty session (header only)", () => {
    const header = createHeader({
      hasGyro: false,
      sessionStartMs: 1_700_000_000_000,
      sampleCount: 0,
    });

    const result = decodeBin(header);

    expect(result.samples).toHaveLength(0);
    expect(result.sampleCount).toBe(0);
  });
});
