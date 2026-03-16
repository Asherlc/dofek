import { createWriteStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";

/** Max upload size: 2 GB */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Stream a request body to a file on disk, enforcing a max size. */
export function streamToFile(
  req: Readable,
  filePath: string,
  maxBytes = MAX_UPLOAD_BYTES,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let bytesReceived = 0;
    const ws = createWriteStream(filePath);

    req.on("data", (chunk: Buffer) => {
      bytesReceived += chunk.length;
      if (bytesReceived > maxBytes) {
        req.destroy(new Error(`Upload exceeds maximum size of ${maxBytes} bytes`));
      }
    });

    req.pipe(ws);
    ws.on("finish", resolve);
    ws.on("error", reject);
    req.on("error", reject);
  });
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
