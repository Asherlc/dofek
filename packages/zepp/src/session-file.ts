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
import { createHeader, encodeChunk, HEADER_SIZE, patchHeaderSampleCount } from "./imu-format.ts";
import type { ImuSample, SessionFileMeta } from "./types.ts";

interface SessionMeta {
  sampleCount: number;
  observedHzX100: number;
  hasGyro: boolean;
  updatedAt: number;
}

export function resetSessionFile(meta: SessionFileMeta, path: string): void {
  const header = createHeader(meta);
  writeFileSync({ path, data: header });
}

export function writeSessionMetaFile(meta: SessionMeta, path: string): void {
  writeFileSync({ path, data: JSON.stringify(meta) });
}

function writeBuffer(fd: number, buffer: ArrayBuffer): void {
  const bytesWritten = writeSync({ fd, buffer });
  if (bytesWritten !== buffer.byteLength) {
    throw new Error(
      `Session file write incomplete: wrote ${bytesWritten} of ${buffer.byteLength} bytes`,
    );
  }
}

export function appendSamples(samples: ImuSample[], hasGyro: boolean, path: string): void {
  if (!samples.length) return;

  const chunk = encodeChunk(samples, hasGyro);
  const fd = openSync({
    path,
    flag: O_WRONLY | O_APPEND | O_CREAT,
  });

  try {
    writeBuffer(fd, chunk);
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
    writeBuffer(fd, patched);
  } finally {
    closeSync({ fd });
  }
}
