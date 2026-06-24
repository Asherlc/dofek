import {
  writeFileSync,
  readFileSync,
  openSync,
  writeSync,
  closeSync,
  O_WRONLY,
  O_RDWR,
  O_APPEND,
  O_CREAT,
} from "@zos/fs";
import {
  createHeader,
  patchHeaderSampleCount,
  encodeChunk,
  HEADER_SIZE,
} from "./imu-format";
import { SESSION_FILE } from "./storage-keys";

export function resetSessionFile(meta) {
  const header = createHeader(meta);
  writeFileSync({
    path: SESSION_FILE,
    data: header,
  });
}

export function appendSamples(samples, hasGyro) {
  if (!samples.length) {
    return;
  }

  const chunk = encodeChunk(samples, hasGyro);
  const fd = openSync({
    path: SESSION_FILE,
    flag: O_WRONLY | O_APPEND | O_CREAT,
  });

  writeSync({
    fd,
    data: chunk,
  });
  closeSync({ fd });
}

export function finalizeSessionFile(sampleCount, observedHzX100) {
  let headerBuffer;

  try {
    headerBuffer = readFileSync({
      path: SESSION_FILE,
      options: {
        encoding: "binary",
      },
    });
  } catch (error) {
    return;
  }

  if (!headerBuffer || headerBuffer.byteLength < HEADER_SIZE) {
    return;
  }

  const patched = patchHeaderSampleCount(
    headerBuffer.slice(0, HEADER_SIZE),
    sampleCount,
    observedHzX100
  );

  const fd = openSync({
    path: SESSION_FILE,
    flag: O_RDWR,
  });

  writeSync({
    fd,
    data: patched,
  });
  closeSync({ fd });
}
