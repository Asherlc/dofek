import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { createDatabaseFromEnv } from "dofek/db";
import { runMigrations } from "dofek/db/migrate";
import express from "express";
import type { Context } from "../shared/trpc.js";
import { appRouter } from "./router.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const isDev = process.env.NODE_ENV !== "production";

/** Stream a request body to a file on disk. */
function streamToFile(req: import("express").Request, filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = createWriteStream(filePath);
    req.pipe(ws);
    ws.on("finish", resolve);
    ws.on("error", reject);
    req.on("error", reject);
  });
}

/** Concatenate chunk files in order into a single output file. */
async function assembleChunks(chunkDir: string, outputPath: string): Promise<void> {
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

async function main() {
  // Auto-run pending migrations on startup
  await runMigrations(process.env.DATABASE_URL!);

  const app = express();
  const db = createDatabaseFromEnv();

  // Chunked Apple Health upload.
  // Client sends chunks with headers: x-upload-id, x-chunk-index, x-chunk-total, x-file-ext
  // Each chunk is saved to a temp dir. When the last chunk arrives, they're assembled and imported.
  const activeUploads = new Map<string, { received: Set<number>; total: number; dir: string }>();

  app.post("/api/upload/apple-health", async (req, res) => {
    const uploadId = req.headers["x-upload-id"] as string | undefined;
    const chunkIndex = parseInt(req.headers["x-chunk-index"] as string, 10);
    const chunkTotal = parseInt(req.headers["x-chunk-total"] as string, 10);
    const fileExt = (req.headers["x-file-ext"] as string) || ".zip";

    // Non-chunked upload (single request, small files)
    if (!uploadId || Number.isNaN(chunkTotal) || chunkTotal <= 1) {
      const sinceDays = parseInt(req.query.sinceDays as string, 10) || 7;
      const fullSync = req.query.fullSync === "true";
      const since = fullSync ? new Date(0) : new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
      const ext = (req.headers["content-type"] ?? "").includes("xml") ? ".xml" : ".zip";
      const tmpFile = join(tmpdir(), `apple-health-${Date.now()}${ext}`);
      try {
        await streamToFile(req, tmpFile);
        const { importAppleHealthFile } = await import("dofek/providers/apple-health");
        const result = await importAppleHealthFile(db, tmpFile, since);
        res.json(result);
      } catch (err: any) {
        console.error("[upload] Apple Health import failed:", err);
        res.status(500).json({ error: err.message ?? "Import failed" });
      } finally {
        await unlink(tmpFile).catch(() => {});
      }
      return;
    }

    // Chunked upload
    try {
      let upload = activeUploads.get(uploadId);
      if (!upload) {
        const dir = join(tmpdir(), `apple-health-chunked-${uploadId}`);
        await mkdir(dir, { recursive: true });
        upload = { received: new Set(), total: chunkTotal, dir };
        activeUploads.set(uploadId, upload);
      }

      // Save this chunk
      const chunkPath = join(upload.dir, `chunk-${String(chunkIndex).padStart(6, "0")}`);
      await streamToFile(req, chunkPath);
      upload.received.add(chunkIndex);

      console.log(`[upload] Chunk ${chunkIndex + 1}/${chunkTotal} for ${uploadId}`);

      // Not all chunks yet — respond with progress
      if (upload.received.size < upload.total) {
        res.json({ status: "partial", received: upload.received.size, total: upload.total });
        return;
      }

      // All chunks received — assemble and import
      console.log(`[upload] All ${chunkTotal} chunks received, assembling...`);
      const assembledFile = join(tmpdir(), `apple-health-${uploadId}${fileExt}`);
      await assembleChunks(upload.dir, assembledFile);
      activeUploads.delete(uploadId);
      await rm(upload.dir, { recursive: true, force: true });

      const fullSync = req.query.fullSync === "true";
      const since = fullSync ? new Date(0) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      const { importAppleHealthFile } = await import("dofek/providers/apple-health");
      const result = await importAppleHealthFile(db, assembledFile, since);
      await unlink(assembledFile).catch(() => {});
      res.json(result);
    } catch (err: any) {
      console.error("[upload] Chunked upload failed:", err);
      // Clean up on error
      const upload = activeUploads.get(uploadId);
      if (upload) {
        activeUploads.delete(uploadId);
        await rm(upload.dir, { recursive: true, force: true }).catch(() => {});
      }
      res.status(500).json({ error: err.message ?? "Upload failed" });
    }
  });

  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext: (): Context => ({ db }),
    }),
  );

  if (isDev) {
    // In dev, use Vite's dev server as middleware
    const { createServer } = await import("vite");
    const vite = await createServer({
      configFile: new URL("../../vite.config.ts", import.meta.url).pathname,
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // In production, serve the built client files
    const { default: path } = await import("node:path");
    const clientDir = path.resolve(import.meta.dirname, "../../client");
    app.use(express.static(clientDir));
    app.get("{*path}", (_req, res) => {
      res.sendFile(path.join(clientDir, "index.html"));
    });
  }

  app.listen(PORT, () => {
    console.log(`[web] Server running at http://localhost:${PORT}`);
    console.log(`[web] tRPC API at http://localhost:${PORT}/api/trpc`);
  });
}

main().catch((err) => {
  console.error("[web] Failed to start:", err);
  process.exit(1);
});
