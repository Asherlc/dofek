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
    expect(result.samples[0]?.x).toBeCloseTo(1.0);
    expect(result.samples[0]?.y).toBeCloseTo(0.5);
    expect(result.samples[0]?.z).toBeCloseTo(-9.8);
    expect(result.samples[1]?.tMs).toBe(100);
    expect(result.samples[1]?.x).toBeCloseTo(1.1);
    expect(result.samples[1]?.y).toBeCloseTo(0.6);
    expect(result.samples[1]?.z).toBeCloseTo(-9.7);
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
    expect(result.samples).toHaveLength(2);
    expect(result.samples[1]?.sensor).toBe("gyroscope");
    expect(result.samples[0]?.tMs).toBe(50);
    expect(result.samples[0]?.x).toBeCloseTo(0.0);
    expect(result.samples[0]?.y).toBeCloseTo(0.1);
    expect(result.samples[0]?.z).toBeCloseTo(-9.8);
    expect(result.samples[1]?.x).toBeCloseTo(0.5);
    expect(result.samples[1]?.y).toBeCloseTo(-0.3);
    expect(result.samples[1]?.z).toBeCloseTo(0.0);
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
    expect(result.samples[2]).toEqual({ tMs: 200, sensor: "accelerometer", x: 7, y: 8, z: 9 });
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

it("rejects unsupported versions and trailing incomplete chunk headers", () => {
  const header = createHeader({ sampleCount: 0 });
  new DataView(header).setUint8(4, 3);
  expect(() => decodeBin(header)).toThrow("Unsupported");
  new DataView(header).setUint8(4, 1);
  expect(() => decodeBin(concat(header, new ArrayBuffer(1)))).toThrow("Truncated");
});

function encodeV2Fixture(
  samples: Array<{ tMs: number; sensor: string; x: number; y: number; z: number }>,
): ArrayBuffer {
  const chunk = new ArrayBuffer(4 + samples.length * 20);
  const view = new DataView(chunk);
  view.setUint16(0, samples.length, true);
  samples.forEach((sample, index) => {
    const offset = 4 + index * 20;
    view.setUint32(offset, sample.tMs, true);
    view.setUint32(offset + 4, sample.sensor === "accelerometer" ? 0 : 1, true);
    view.setFloat32(offset + 8, sample.x, true);
    view.setFloat32(offset + 12, sample.y, true);
    view.setFloat32(offset + 16, sample.z, true);
  });
  return chunk;
}

it("decodes independently timestamped v2 vectors", () => {
  const samples = [
    { tMs: 3, sensor: "gyroscope" as const, x: 1, y: 2, z: 3 },
    { tMs: 8, sensor: "accelerometer" as const, x: 4, y: 5, z: 6 },
  ];
  const header = createHeader({ hasGyro: true, sampleCount: 2 });
  new DataView(header).setUint8(4, 2);
  const result = decodeBin(concat(header, encodeV2Fixture(samples)));
  expect(result.version).toBe(2);
  expect(result.samples).toEqual(samples);
});
it("validates v2 tags, gyro flags, count and truncated vectors", () => {
  const chunk = encodeV2Fixture([{ tMs: 3, sensor: "gyroscope", x: 1, y: 2, z: 3 }]);
  const header = createHeader({ hasGyro: true, sampleCount: 1 });
  const view = new DataView(header);
  view.setUint8(4, 2);
  view.setUint8(5, 0);
  expect(() => decodeBin(concat(header, chunk))).toThrow("flag");
  view.setUint8(5, 1);
  expect(() => decodeBin(concat(header, chunk.slice(0, -1)))).toThrow("Truncated");
  new DataView(chunk).setUint32(8, 2, true);
  expect(() => decodeBin(concat(header, chunk))).toThrow("tag");
  expect(() => decodeBin(header)).toThrow("count mismatch");
});
