import { createWriteStream, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabaseFromEnv } from "./db/index.js";
import { importAppleHealthFile } from "./providers/apple-health.js";

const PORT = parseInt(process.env.UPLOAD_PORT ?? "9877", 10);
const API_KEY = process.env.UPLOAD_API_KEY;

function parseSince(url: URL): Date {
  const days = parseInt(url.searchParams.get("since-days") ?? "7", 10);
  const fullSync = url.searchParams.get("full-sync") === "true";
  return fullSync ? new Date(0) : new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

const server = createServer(async (req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  // Apple Health upload
  if (req.method === "POST" && req.url?.startsWith("/upload/apple-health")) {
    // API key auth
    if (API_KEY) {
      const authHeader = req.headers.authorization;
      if (authHeader !== `Bearer ${API_KEY}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const since = parseSince(url);

      // Save uploaded file to temp directory
      const tmpDir = join(tmpdir(), `apple-health-upload-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });
      const filePath = join(tmpDir, "export.zip");

      await new Promise<void>((resolve, reject) => {
        const writeStream = createWriteStream(filePath);
        req.pipe(writeStream);
        writeStream.on("finish", resolve);
        writeStream.on("error", reject);
        req.on("error", reject);
      });

      console.log(`[server] Received upload, saved to ${filePath}`);

      // Run import
      const db = createDatabaseFromEnv();
      const result = await importAppleHealthFile(db, filePath, since);

      // Cleanup
      try {
        const { rmSync } = await import("node:fs");
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }

      const status = result.errors.length > 0 ? 207 : 200;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          recordsSynced: result.recordsSynced,
          errors: result.errors.map((e) => e.message),
          duration: result.duration,
        }),
      );
    } catch (err) {
      console.error("[server] Import failed:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT}`);
  console.log(`[server] Upload endpoint: POST /upload/apple-health`);
  if (API_KEY) {
    console.log("[server] API key auth enabled");
  } else {
    console.log("[server] WARNING: No UPLOAD_API_KEY set — endpoint is unauthenticated");
  }
});
