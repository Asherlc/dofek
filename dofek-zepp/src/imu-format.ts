import type { HeaderMeta, ImuSample } from "./types.ts";

export const MAGIC = 0x314d5549;
export const FORMAT_VERSION = 1;
export const HEADER_SIZE = 32;
export const FLAG_HAS_GYRO = 1;

export function createHeader(options: HeaderMeta): ArrayBuffer {
  const {
    hasGyro = false,
    sessionStartMs = 0,
    sampleCount = 0,
    accelFreqMode = 1,
    gyroFreqMode = 1,
    observedHzX100 = 0,
  } = options;

  const buffer = new ArrayBuffer(HEADER_SIZE);
  const view = new DataView(buffer);

  view.setUint32(0, MAGIC, true);
  view.setUint8(4, FORMAT_VERSION);
  view.setUint8(5, hasGyro ? FLAG_HAS_GYRO : 0);
  view.setUint16(6, 0, true);
  view.setUint32(8, sessionStartMs >>> 0, true);
  view.setUint32(12, Math.floor(sessionStartMs / 0x100000000) >>> 0, true);
  view.setUint32(16, sampleCount >>> 0, true);
  view.setUint8(20, accelFreqMode);
  view.setUint8(21, hasGyro ? gyroFreqMode : 0);
  view.setUint16(22, observedHzX100, true);

  return buffer;
}

export function patchHeaderSampleCount(
  headerBuffer: ArrayBuffer,
  sampleCount: number,
  observedHzX100?: number,
): ArrayBuffer {
  const view = new DataView(headerBuffer);
  view.setUint32(16, sampleCount >>> 0, true);
  if (typeof observedHzX100 === "number") {
    view.setUint16(22, observedHzX100, true);
  }
  return headerBuffer;
}

export function encodeChunk(samples: ImuSample[], hasGyro: boolean): ArrayBuffer {
  const recordSize = hasGyro ? 28 : 16;
  const buffer = new ArrayBuffer(4 + samples.length * recordSize);
  const view = new DataView(buffer);

  view.setUint16(0, samples.length, true);
  view.setUint16(2, 0, true);

  let offset = 4;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i];
    if (!sample) continue;
    view.setUint32(offset, sample.tMs >>> 0, true);
    offset += 4;
    view.setFloat32(offset, sample.ax, true);
    offset += 4;
    view.setFloat32(offset, sample.ay, true);
    offset += 4;
    view.setFloat32(offset, sample.az, true);
    offset += 4;

    if (hasGyro) {
      view.setFloat32(offset, sample.gx || 0, true);
      offset += 4;
      view.setFloat32(offset, sample.gy || 0, true);
      offset += 4;
      view.setFloat32(offset, sample.gz || 0, true);
      offset += 4;
    }
  }

  return buffer;
}

export function concatArrayBuffers(buffers: ArrayBuffer[]): ArrayBuffer {
  const total = buffers.reduce((sum, buf) => sum + buf.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;

  for (let i = 0; i < buffers.length; i += 1) {
    const buf = buffers[i];
    if (!buf) continue;
    merged.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }

  return merged.buffer;
}
