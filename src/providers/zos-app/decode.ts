export interface ImuSample {
  tMs: number;
  ax: number;
  ay: number;
  az: number;
  gx?: number;
  gy?: number;
  gz?: number;
}

export interface DecodedSession {
  version: number;
  hasGyro: boolean;
  sessionStartMs: number;
  sampleCount: number;
  accelFreqMode: number;
  gyroFreqMode: number;
  observedHz: number;
  samples: ImuSample[];
}

const MAGIC = 0x314d5549;
const HEADER_SIZE = 32;
const FLAG_HAS_GYRO = 1;
const ACCEL_RECORD_SIZE = 16;
const GYRO_RECORD_SIZE = 28;

export function decodeBin(buffer: ArrayBufferLike): DecodedSession {
  const view = new DataView(buffer instanceof ArrayBuffer ? buffer : new Uint8Array(buffer).buffer);

  if (view.byteLength < HEADER_SIZE) {
    throw new Error(`File too small: ${view.byteLength} bytes (minimum ${HEADER_SIZE})`);
  }

  const magic = view.getUint32(0, true);
  if (magic !== MAGIC) {
    throw new Error(`Invalid magic: 0x${magic.toString(16)}`);
  }

  const version = view.getUint8(4);
  const flags = view.getUint8(5);
  const hasGyro = (flags & FLAG_HAS_GYRO) !== 0;
  const sessionStartMs = view.getUint32(8, true);
  const sampleCount = view.getUint32(12, true);
  const accelFreqMode = view.getUint8(16);
  const gyroFreqMode = hasGyro ? view.getUint8(17) : 0;
  const observedHzX100 = view.getUint16(18, true);

  const samples: ImuSample[] = [];
  let offset = HEADER_SIZE;
  const recordSize = hasGyro ? GYRO_RECORD_SIZE : ACCEL_RECORD_SIZE;

  while (offset + 4 <= view.byteLength) {
    const chunkCount = view.getUint16(offset, true);
    offset += 4;

    const maxReadable = Math.floor((view.byteLength - offset) / recordSize);
    const actualCount = Math.min(chunkCount, maxReadable);

    for (let i = 0; i < actualCount; i++) {
      const tMs = view.getUint32(offset, true);
      offset += 4;
      const ax = view.getFloat32(offset, true);
      offset += 4;
      const ay = view.getFloat32(offset, true);
      offset += 4;
      const az = view.getFloat32(offset, true);
      offset += 4;

      const sample: ImuSample = { tMs, ax, ay, az };

      if (hasGyro) {
        sample.gx = view.getFloat32(offset, true);
        offset += 4;
        sample.gy = view.getFloat32(offset, true);
        offset += 4;
        sample.gz = view.getFloat32(offset, true);
        offset += 4;
      }

      samples.push(sample);
    }

    if (actualCount < chunkCount) {
      offset += (chunkCount - actualCount) * recordSize;
    }
  }

  return {
    version,
    hasGyro,
    sessionStartMs,
    sampleCount,
    accelFreqMode,
    gyroFreqMode,
    observedHz: observedHzX100 / 100,
    samples,
  };
}
