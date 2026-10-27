export interface BinarySample {
  tMs: number;
  sensor: "accelerometer" | "gyroscope";
  x: number;
  y: number;
  z: number;
}

export interface DecodedSession {
  version: number;
  hasGyro: boolean;
  sessionStartMs: number;
  sampleCount: number;
  accelFreqMode: number;
  gyroFreqMode: number;
  observedHz: number;
  samples: BinarySample[];
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
  if (version !== 1 && version !== 2) throw new Error(`Unsupported IMU format version: ${version}`);
  const flags = view.getUint8(5);
  const hasGyro = (flags & FLAG_HAS_GYRO) !== 0;
  const sessionStartMsLow = view.getUint32(8, true);
  const sessionStartMsHigh = view.getUint32(12, true);
  const sessionStartMs = sessionStartMsLow + sessionStartMsHigh * 0x100000000;
  const sampleCount = view.getUint32(16, true);
  const accelFreqMode = view.getUint8(20);
  const gyroFreqMode = hasGyro ? view.getUint8(21) : 0;
  const observedHzX100 = view.getUint16(22, true);

  const samples: BinarySample[] = [];
  let offset = HEADER_SIZE;
  const recordSize = version === 2 ? 20 : hasGyro ? GYRO_RECORD_SIZE : ACCEL_RECORD_SIZE;
  let recordCount = 0;

  while (offset < view.byteLength) {
    if (offset + 4 > view.byteLength) throw new Error("Truncated chunk header");
    const chunkCount = view.getUint16(offset, true);
    offset += 4;

    recordCount += chunkCount;
    const maxReadable = Math.floor((view.byteLength - offset) / recordSize);
    const actualCount = Math.min(chunkCount, maxReadable);

    for (let i = 0; i < actualCount; i++) {
      const tMs = view.getUint32(offset, true);
      offset += 4;
      const tag = version === 2 ? view.getUint32(offset, true) : 0;
      if (version === 2) offset += 4;
      if (tag !== 0 && tag !== 1) throw new Error("Invalid IMU sensor tag");
      if (tag === 1 && !hasGyro) throw new Error("Gyroscope record without header flag");
      const xValue = view.getFloat32(offset, true);
      const yValue = view.getFloat32(offset + 4, true);
      const zValue = view.getFloat32(offset + 8, true);
      offset += 12;
      samples.push({
        tMs,
        sensor: tag === 0 ? "accelerometer" : "gyroscope",
        x: xValue,
        y: yValue,
        z: zValue,
      });
      if (version === 1 && hasGyro) {
        samples.push({
          tMs,
          sensor: "gyroscope",
          x: view.getFloat32(offset, true),
          y: view.getFloat32(offset + 4, true),
          z: view.getFloat32(offset + 8, true),
        });
        offset += 12;
      }
    }

    if (actualCount < chunkCount) {
      throw new Error(
        `Truncated chunk: declared ${chunkCount} samples but only ${actualCount} fit in remaining ${view.byteLength - offset + actualCount * recordSize} bytes`,
      );
    }
  }

  if (recordCount !== sampleCount) {
    throw new Error(
      `Sample count mismatch: header declared ${sampleCount} but decoded ${recordCount}`,
    );
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
