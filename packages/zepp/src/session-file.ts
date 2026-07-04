import {
  closeSync,
  O_APPEND,
  O_CREAT,
  O_RDWR,
  O_WRONLY,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "@zos/fs";
import {
  concatArrayBuffers,
  createHeader,
  encodeChunk,
  encodeImuChunk,
  encodeLocationChunk,
  encodePhysicalScalarChunk,
  HEADER_SIZE,
  patchHeaderSampleCount,
} from "./imu-format.ts";
import type { ImuSample, LocationSample, PhysicalScalarSample, SessionFileMeta } from "./types.ts";

interface SessionSamples {
  imuSamples: ImuSample[];
  scalarSamples: PhysicalScalarSample[];
  locationSamples: LocationSample[];
  hasGyro: boolean;
  path: string;
}

export function resetSessionFile(
  meta: SessionFileMeta & { formatVersion?: number },
  path: string,
): void {
  const header = createHeader(meta);
  writeFileSync({ path, data: header });
}

export function appendSamples(samples: ImuSample[], hasGyro: boolean, path: string): void {
  if (!samples.length) return;

  const chunk = encodeChunk(samples, hasGyro);
  const fd = openSync({
    path,
    flag: O_WRONLY | O_APPEND | O_CREAT,
  });

  try {
    writeSync({ fd, data: chunk });
  } finally {
    closeSync({ fd });
  }
}

export function appendPhysicalSamples(
  scalarSamples: PhysicalScalarSample[],
  locationSamples: LocationSample[],
  path: string,
): void {
  if (!scalarSamples.length && !locationSamples.length) return;

  const chunks: ArrayBuffer[] = [];
  if (scalarSamples.length) {
    chunks.push(encodePhysicalScalarChunk(scalarSamples));
  }
  if (locationSamples.length) {
    chunks.push(encodeLocationChunk(locationSamples));
  }

  const fd = openSync({
    path,
    flag: O_WRONLY | O_APPEND | O_CREAT,
  });

  try {
    writeSync({ fd, data: concatArrayBuffers(chunks) });
  } finally {
    closeSync({ fd });
  }
}

export function appendSessionSamples({
  imuSamples,
  scalarSamples,
  locationSamples,
  hasGyro,
  path,
}: SessionSamples): void {
  if (!imuSamples.length && !scalarSamples.length && !locationSamples.length) return;

  const chunks: ArrayBuffer[] = [];
  if (imuSamples.length) {
    chunks.push(encodeImuChunk(imuSamples, hasGyro));
  }
  if (scalarSamples.length) {
    chunks.push(encodePhysicalScalarChunk(scalarSamples));
  }
  if (locationSamples.length) {
    chunks.push(encodeLocationChunk(locationSamples));
  }

  const fd = openSync({
    path,
    flag: O_WRONLY | O_APPEND | O_CREAT,
  });

  try {
    writeSync({ fd, data: concatArrayBuffers(chunks) });
  } finally {
    closeSync({ fd });
  }
}

export function finalizeSessionFile(
  sampleCount: number,
  observedHzX100: number,
  path: string,
): void {
  let raw: ArrayBuffer | string | undefined;

  try {
    raw = readFileSync({
      path,
      options: { encoding: "binary" },
    });
  } catch {
    return;
  }

  if (typeof raw === "string" || !raw || raw.byteLength < HEADER_SIZE) return;

  const patched = patchHeaderSampleCount(raw.slice(0, HEADER_SIZE), sampleCount, observedHzX100);

  const fd = openSync({ path, flag: O_RDWR });
  try {
    writeSync({ fd, data: patched });
  } finally {
    closeSync({ fd });
  }
}
