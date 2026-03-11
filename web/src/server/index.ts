import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import express from "express";
import { createDatabaseFromEnv } from "health-data/db";
import type { Context } from "../shared/trpc.js";
import { appRouter } from "./router.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const isDev = process.env.NODE_ENV !== "production";

async function main() {
  const app = express();
  const db = createDatabaseFromEnv();

  // Apple Health file upload — streams to disk to handle 1GB+ files
  app.post("/api/upload/apple-health", async (req, res) => {
    const sinceDays = parseInt(req.query.sinceDays as string, 10) || 7;
    const fullSync = req.query.fullSync === "true";
    const since = fullSync ? new Date(0) : new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

    const ext = (req.headers["content-type"] ?? "").includes("xml") ? ".xml" : ".zip";
    const tmpFile = join(tmpdir(), `apple-health-${Date.now()}${ext}`);

    try {
      // Stream request body to temp file
      await new Promise<void>((resolve, reject) => {
        const ws = createWriteStream(tmpFile);
        req.pipe(ws);
        ws.on("finish", resolve);
        ws.on("error", reject);
        req.on("error", reject);
      });

      const { importAppleHealthFile } = await import("health-data/providers/apple-health");
      const result = await importAppleHealthFile(db, tmpFile, since);
      res.json(result);
    } catch (err: any) {
      console.error("[upload] Apple Health import failed:", err);
      res.status(500).json({ error: err.message ?? "Import failed" });
    } finally {
      await unlink(tmpFile).catch(() => {});
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
    const clientDir = path.resolve(import.meta.dirname, "../../dist/client");
    app.use(express.static(clientDir));
    app.get("*", (_req, res) => {
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
