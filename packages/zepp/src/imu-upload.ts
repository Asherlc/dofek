import { readFileSync } from "@zos/fs";
import { FLAG_HAS_GYRO, HEADER_SIZE, MAGIC } from "./imu-format.ts";

interface ImuUploadBatch {
  data: number[];
  sampleOffset: number;
}

/** Send file records intact over ZML; only server acknowledgements release the caller's file. */
export async function uploadImuFile(
  path: string,
  send: (batch: ImuUploadBatch) => Promise<unknown>,
): Promise<void> {
  const file = readFileSync({ path, options: { encoding: "binary" } });
  if (!file || typeof file === "string" || file.byteLength < HEADER_SIZE) {
    throw new Error("IMU file header is missing or truncated");
  }
  const view = new DataView(file);
  if (view.getUint32(0, true) !== MAGIC) throw new Error("Invalid IMU file magic");
  const version = view.getUint8(4);
  if (version !== 1 && version !== 2) throw new Error("Unsupported IMU file version");
  const recordSize = version === 2 ? 20 : view.getUint8(5) & FLAG_HAS_GYRO ? 28 : 16;
  const chunks: Array<{ start: number; count: number }> = [];
  let offset = HEADER_SIZE;
  let total = 0;
  while (offset < file.byteLength) {
    if (offset + 4 > file.byteLength) throw new Error("IMU chunk header is truncated");
    const count = view.getUint16(offset, true);
    offset += 4;
    if (offset + count * recordSize > file.byteLength) throw new Error("IMU chunk is truncated");
    chunks.push({ start: offset, count });
    total += count;
    offset += count * recordSize;
  }
  if (total !== view.getUint32(16, true)) throw new Error("IMU sample count mismatch");
  if (total === 0) throw new Error("IMU file has no samples to upload");

  let sampleOffset = 0;
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.count; index += 128) {
      const count = Math.min(128, chunk.count - index);
      const bytes = new Uint8Array(HEADER_SIZE + 4 + count * recordSize);
      bytes.set(new Uint8Array(file, 0, HEADER_SIZE));
      const batchView = new DataView(bytes.buffer);
      batchView.setUint32(16, count, true);
      batchView.setUint16(HEADER_SIZE, count, true);
      bytes.set(
        new Uint8Array(file, chunk.start + index * recordSize, count * recordSize),
        HEADER_SIZE + 4,
      );
      const acknowledgement = await send({ data: Array.from(bytes), sampleOffset });
      if (
        typeof acknowledgement !== "object" ||
        acknowledgement === null ||
        !("ok" in acknowledgement) ||
        acknowledgement.ok !== true
      ) {
        throw new Error("Dofek did not acknowledge the IMU batch");
      }
      sampleOffset += count;
    }
  }
}
