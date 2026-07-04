export interface BinarySample {
  tMs: number;
  ax: number;
  ay: number;
  az: number;
  gx?: number;
  gy?: number;
  gz?: number;
}

export type PhysicalScalarChannel =
  | "heartRate"
  | "spo2"
  | "stress"
  | "bodyTemperature"
  | "barometricPressure"
  | "altitude"
  | "compassHeading";

export interface PhysicalScalarDecodedSample {
  tMs: number;
  channel: PhysicalScalarChannel;
  value: number;
  status: number;
}

export interface LocationDecodedSample {
  tMs: number;
  latitude: number;
  longitude: number;
  altitude?: number;
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
  physicalSamples: PhysicalScalarDecodedSample[];
  locationSamples: LocationDecodedSample[];
}

const MAGIC = 0x314d5549;
const FORMAT_VERSION_V2 = 2;
const HEADER_SIZE = 32;
const FLAG_HAS_GYRO = 1;
const ACCEL_RECORD_SIZE = 16;
const GYRO_RECORD_SIZE = 28;
const CHUNK_TYPE_IMU = 1;
const CHUNK_TYPE_SCALAR = 2;
const CHUNK_TYPE_LOCATION = 3;
const SCALAR_RECORD_SIZE = 16;
const LOCATION_RECORD_SIZE = 24;

interface HeaderFields {
  version: number;
  hasGyro: boolean;
  sessionStartMs: number;
  sampleCount: number;
  accelFreqMode: number;
  gyroFreqMode: number;
  observedHz: number;
}

interface ImuDecodeResult {
  offset: number;
  samples: BinarySample[];
}

function getPhysicalScalarChannel(channelId: number): PhysicalScalarChannel {
  switch (channelId) {
    case 1:
      return "heartRate";
    case 2:
      return "spo2";
    case 3:
      return "stress";
    case 4:
      return "bodyTemperature";
    case 5:
      return "barometricPressure";
    case 6:
      return "altitude";
    case 7:
      return "compassHeading";
    default:
      throw new Error(`Unsupported physical sample channel id: ${channelId}`);
  }
}

function decodeImuRecords(
  view: DataView,
  offset: number,
  chunkCount: number,
  hasGyro: boolean,
): ImuDecodeResult {
  const recordSize = hasGyro ? GYRO_RECORD_SIZE : ACCEL_RECORD_SIZE;
  const maxReadable = Math.floor((view.byteLength - offset) / recordSize);
  const actualCount = Math.min(chunkCount, maxReadable);
  const samples: BinarySample[] = [];

  for (let sampleIndex = 0; sampleIndex < actualCount; sampleIndex += 1) {
    const tMs = view.getUint32(offset, true);
    offset += 4;
    const ax = view.getFloat32(offset, true);
    offset += 4;
    const ay = view.getFloat32(offset, true);
    offset += 4;
    const az = view.getFloat32(offset, true);
    offset += 4;

    const sample: BinarySample = { tMs, ax, ay, az };

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
    throw new Error(
      `Truncated chunk: declared ${chunkCount} samples but only ${actualCount} fit in remaining ${view.byteLength - offset + actualCount * recordSize} bytes`,
    );
  }

  return { offset, samples };
}

function decodeV1Samples(view: DataView, offset: number, header: HeaderFields): BinarySample[] {
  const samples: BinarySample[] = [];

  while (offset + 4 <= view.byteLength) {
    const chunkCount = view.getUint16(offset, true);
    offset += 4;
    const decoded = decodeImuRecords(view, offset, chunkCount, header.hasGyro);
    offset = decoded.offset;
    samples.push(...decoded.samples);
  }

  return samples;
}

function decodeV2Chunks(
  view: DataView,
  offset: number,
): {
  samples: BinarySample[];
  physicalSamples: PhysicalScalarDecodedSample[];
  locationSamples: LocationDecodedSample[];
} {
  const samples: BinarySample[] = [];
  const physicalSamples: PhysicalScalarDecodedSample[] = [];
  const locationSamples: LocationDecodedSample[] = [];

  while (offset + 4 <= view.byteLength) {
    const chunkType = view.getUint8(offset);
    const chunkFlags = view.getUint8(offset + 1);
    const chunkCount = view.getUint16(offset + 2, true);
    offset += 4;

    if (chunkType === CHUNK_TYPE_IMU) {
      const decoded = decodeImuRecords(
        view,
        offset,
        chunkCount,
        (chunkFlags & FLAG_HAS_GYRO) !== 0,
      );
      offset = decoded.offset;
      samples.push(...decoded.samples);
      continue;
    }

    if (chunkType === CHUNK_TYPE_SCALAR) {
      const requiredBytes = chunkCount * SCALAR_RECORD_SIZE;
      if (offset + requiredBytes > view.byteLength) {
        throw new Error(
          `Truncated chunk: declared ${chunkCount} samples but only ${Math.floor((view.byteLength - offset) / SCALAR_RECORD_SIZE)} fit in remaining ${view.byteLength - offset} bytes`,
        );
      }

      for (let sampleIndex = 0; sampleIndex < chunkCount; sampleIndex += 1) {
        const tMs = view.getUint32(offset, true);
        offset += 4;
        const channel = getPhysicalScalarChannel(view.getUint8(offset));
        offset += 1;
        const status = view.getUint8(offset);
        offset += 1;
        offset += 2;
        const value = view.getFloat64(offset, true);
        offset += 8;
        physicalSamples.push({ tMs, channel, value, status });
      }
      continue;
    }

    if (chunkType === CHUNK_TYPE_LOCATION) {
      const requiredBytes = chunkCount * LOCATION_RECORD_SIZE;
      if (offset + requiredBytes > view.byteLength) {
        throw new Error(
          `Truncated chunk: declared ${chunkCount} samples but only ${Math.floor((view.byteLength - offset) / LOCATION_RECORD_SIZE)} fit in remaining ${view.byteLength - offset} bytes`,
        );
      }

      for (let sampleIndex = 0; sampleIndex < chunkCount; sampleIndex += 1) {
        const tMs = view.getUint32(offset, true);
        offset += 4;
        const latitude = view.getFloat64(offset, true);
        offset += 8;
        const longitude = view.getFloat64(offset, true);
        offset += 8;
        const altitude = view.getFloat32(offset, true);
        offset += 4;
        const locationSample: LocationDecodedSample = { tMs, latitude, longitude };
        if (!Number.isNaN(altitude)) {
          locationSample.altitude = altitude;
        }
        locationSamples.push(locationSample);
      }
      continue;
    }

    throw new Error(`Unsupported v2 chunk type: ${chunkType}`);
  }

  if (offset !== view.byteLength) {
    throw new Error(`Truncated v2 chunk header: ${view.byteLength - offset} trailing bytes`);
  }

  return { samples, physicalSamples, locationSamples };
}

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
  const sessionStartMsLow = view.getUint32(8, true);
  const sessionStartMsHigh = view.getUint32(12, true);
  const sessionStartMs = sessionStartMsLow + sessionStartMsHigh * 0x100000000;
  const sampleCount = view.getUint32(16, true);
  const accelFreqMode = view.getUint8(20);
  const gyroFreqMode = hasGyro ? view.getUint8(21) : 0;
  const observedHzX100 = view.getUint16(22, true);

  const header: HeaderFields = {
    version,
    hasGyro,
    sessionStartMs,
    sampleCount,
    accelFreqMode,
    gyroFreqMode,
    observedHz: observedHzX100 / 100,
  };

  const decoded =
    version === FORMAT_VERSION_V2
      ? decodeV2Chunks(view, HEADER_SIZE)
      : {
          samples: decodeV1Samples(view, HEADER_SIZE, header),
          physicalSamples: [],
          locationSamples: [],
        };

  if (decoded.samples.length !== sampleCount) {
    throw new Error(
      `Sample count mismatch: header declared ${sampleCount} but decoded ${decoded.samples.length}`,
    );
  }

  return {
    version: header.version,
    hasGyro: header.hasGyro,
    sessionStartMs: header.sessionStartMs,
    sampleCount: header.sampleCount,
    accelFreqMode: header.accelFreqMode,
    gyroFreqMode: header.gyroFreqMode,
    observedHz: header.observedHz,
    samples: decoded.samples,
    physicalSamples: decoded.physicalSamples,
    locationSamples: decoded.locationSamples,
  };
}
