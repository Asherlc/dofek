/**
 * Extracted upload-server handler — testable without side effects.
 * The thin bootstrap in src/server.ts calls createUploadHandler() and listens.
 */
import { createWriteStream, mkdirSync } from "node:fs";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeSinceDate } from "./cli.ts";
import type { Database, SyncDatabase } from "./db/index.ts";
import type { SyncResult } from "./providers/types.ts";

/** Parse `since-days` and `full-sync` query params into a cutoff Date. */
export function parseSince(url: URL): Date {
  const days = parseInt(url.searchParams.get("since-days") ?? "7", 10);
  const fullSync = url.searchParams.get("full-sync") === "true";
  return computeSinceDate(days, fullSync);
}

export interface UploadHandlerDependencies {
  createDatabase: () => Database;
  importAppleHealth: (db: SyncDatabase, filePath: string, since: Date) => Promise<SyncResult>;
  apiKey: string | undefined;
}

/** Create the HTTP request handler for the upload server. */
export function createUploadHandler(deps: UploadHandlerDependencies): RequestListener {
  return async (req: IncomingMessage, res: ServerResponse) => {
    // Health check
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // Apple Health upload
    if (req.method === "POST" && req.url?.startsWith("/upload/apple-health")) {
      // API key auth
      if (deps.apiKey) {
        const authHeader = req.headers.authorization;
        if (authHeader !== `Bearer ${deps.apiKey}`) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
      }

      try {
        const url = new URL(req.url, "http://localhost");
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
        const db = deps.createDatabase();
        const result = await deps.importAppleHealth(db, filePath, since);

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
  };
}
