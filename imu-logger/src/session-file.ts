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
import { SESSION_FILE } from "./storage-keys.ts";
import type { ImuSample, SessionFileMeta } from "./types.ts";

export function resetSessionFile(meta: SessionFileMeta): void {
  const header = createHeader(meta);
  writeFileSync({ path: SESSION_FILE, data: header });
}

export function appendSamples(samples: ImuSample[], hasGyro: boolean): void {
  if (!samples.length) return;

  const chunk = encodeChunk(samples, hasGyro);
  const fd = openSync({
    path: SESSION_FILE,
    flag: O_WRONLY | O_APPEND | O_CREAT,
  });

  try {
    writeSync({ fd, data: chunk });
  } finally {
    closeSync({ fd });
  }
}

export function finalizeSessionFile(sampleCount: number, observedHzX100: number): void {
  let raw: ArrayBuffer | string | undefined;

  try {
    raw = readFileSync({
      path: SESSION_FILE,
      options: { encoding: "binary" },
    });
  } catch {
    return;
  }

  if (typeof raw === "string" || !raw || raw.byteLength < HEADER_SIZE) return;

  const patched = patchHeaderSampleCount(raw.slice(0, HEADER_SIZE), sampleCount, observedHzX100);

  const fd = openSync({ path: SESSION_FILE, flag: O_RDWR });
  try {
    writeSync({ fd, data: patched });
  } finally {
    closeSync({ fd });
  }
}
