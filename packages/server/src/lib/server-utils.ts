import { createWriteStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Max upload size: 2 GB */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Stream a request body to a file on disk, enforcing a max size. */
export async function streamToFile(
  req: Readable,
  filePath: string,
  maxBytes = MAX_UPLOAD_BYTES,
): Promise<number> {
  let bytesReceived = 0;
  const sizeLimiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesReceived += chunk.length;
      if (bytesReceived > maxBytes) {
        callback(new Error(`Upload exceeds maximum size of ${maxBytes} bytes`));
        return;
      }
      callback(null, chunk);
    },
  });
  await pipeline(req, sizeLimiter, createWriteStream(filePath));
  return bytesReceived;
}

/** Concatenate chunk files in order into a single output file. */
export async function assembleChunks(chunkDir: string, outputPath: string): Promise<void> {
  const { createReadStream } = await import("node:fs");
  const { pipeline } = await import("node:stream/promises");
  const files = (await readdir(chunkDir)).filter((f) => f.startsWith("chunk-")).sort();
  const ws = createWriteStream(outputPath);
  for (const file of files) {
    await pipeline(createReadStream(join(chunkDir, file)), ws, { end: false });
  }
  ws.end();
  await new Promise<void>((resolve, reject) => {
    ws.on("finish", resolve);
    ws.on("error", reject);
  });
}
