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

  // ── Apple Health upload state ──
  interface UploadChunks {
    received: Set<number>;
    total: number;
    dir: string;
  }
  interface JobStatus {
    status: "uploading" | "assembling" | "processing" | "done" | "error";
    progress?: number;
    message?: string;
    result?: any;
  }
  const activeUploads = new Map<string, UploadChunks>();
  const jobStatuses = new Map<string, JobStatus>();

  // Clean up completed jobs after 10 minutes
  function setJobStatus(id: string, status: JobStatus) {
    jobStatuses.set(id, status);
    if (status.status === "done" || status.status === "error") {
      setTimeout(() => jobStatuses.delete(id), 10 * 60 * 1000);
    }
  }

  // Background import — fires and forgets, updates jobStatuses as it runs
  function startBackgroundImport(jobId: string, filePath: string, since: Date) {
    setJobStatus(jobId, { status: "processing", progress: 0, message: "Starting import..." });

    (async () => {
      try {
        const { importAppleHealthFile } = await import("dofek/providers/apple-health");
        const result = await importAppleHealthFile(db, filePath, since, (info) => {
          setJobStatus(jobId, {
            status: "processing",
            progress: info.pct,
            message: `Processing: ${info.pct}%`,
          });
        });
        setJobStatus(jobId, {
          status: "done",
          progress: 100,
          message: `${result.recordsSynced} records imported, ${result.errors?.length ?? 0} errors`,
          result,
        });
      } catch (err: any) {
        console.error("[upload] Background import failed:", err);
        setJobStatus(jobId, {
          status: "error",
          message: err.message ?? "Import failed",
        });
      } finally {
        await unlink(filePath).catch(() => {});
      }
    })();
  }

  // Poll job status
  app.get("/api/upload/apple-health/status/:jobId", (req, res) => {
    const status = jobStatuses.get(req.params.jobId);
    if (!status) {
      res.status(404).json({ error: "Unknown job" });
      return;
    }
    res.json(status);
  });

  // Chunked upload endpoint
  app.post("/api/upload/apple-health", async (req, res) => {
    const uploadId = req.headers["x-upload-id"] as string | undefined;
    const chunkIndex = parseInt(req.headers["x-chunk-index"] as string, 10);
    const chunkTotal = parseInt(req.headers["x-chunk-total"] as string, 10);
    const fileExt = (req.headers["x-file-ext"] as string) || ".zip";
    const fullSync = req.query.fullSync === "true";
    const since = fullSync ? new Date(0) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Non-chunked upload (single small file) — still processes in background
    if (!uploadId || Number.isNaN(chunkTotal) || chunkTotal <= 1) {
      const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const ext = (req.headers["content-type"] ?? "").includes("xml") ? ".xml" : ".zip";
      const tmpFile = join(tmpdir(), `apple-health-${jobId}${ext}`);
      try {
        await streamToFile(req, tmpFile);
        startBackgroundImport(jobId, tmpFile, since);
        res.json({ status: "processing", jobId });
      } catch (err: any) {
        console.error("[upload] Apple Health upload failed:", err);
        res.status(500).json({ error: err.message ?? "Upload failed" });
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
        setJobStatus(uploadId, {
          status: "uploading",
          progress: 0,
          message: "Receiving chunks...",
        });
      }

      const chunkPath = join(upload.dir, `chunk-${String(chunkIndex).padStart(6, "0")}`);
      await streamToFile(req, chunkPath);
      upload.received.add(chunkIndex);

      const uploadPct = Math.round((upload.received.size / upload.total) * 100);
      console.log(`[upload] Chunk ${chunkIndex + 1}/${chunkTotal} for ${uploadId}`);

      if (upload.received.size < upload.total) {
        setJobStatus(uploadId, {
          status: "uploading",
          progress: uploadPct,
          message: `Received ${upload.received.size}/${upload.total} chunks`,
        });
        res.json({
          status: "uploading",
          jobId: uploadId,
          received: upload.received.size,
          total: upload.total,
        });
        return;
      }

      // All chunks received — assemble then process in background
      setJobStatus(uploadId, { status: "assembling", progress: 0, message: "Assembling file..." });
      const assembledFile = join(tmpdir(), `apple-health-${uploadId}${fileExt}`);
      await assembleChunks(upload.dir, assembledFile);
      activeUploads.delete(uploadId);
      await rm(upload.dir, { recursive: true, force: true });

      startBackgroundImport(uploadId, assembledFile, since);
      res.json({ status: "processing", jobId: uploadId });
    } catch (err: any) {
      console.error("[upload] Chunked upload failed:", err);
      const upload = activeUploads.get(uploadId);
      if (upload) {
        activeUploads.delete(uploadId);
        await rm(upload.dir, { recursive: true, force: true }).catch(() => {});
      }
      setJobStatus(uploadId, { status: "error", message: err.message ?? "Upload failed" });
      res.status(500).json({ error: err.message ?? "Upload failed" });
    }
  });

  // ── OAuth callback for providers that need a public redirect URI ──
  app.get("/auth/:provider", async (req, res) => {
    try {
      const providerId = req.params.provider;
      const { getAllProviders } = await import("dofek/providers/registry");
      const { ensureProvidersRegistered } = await import("./routers/sync.js");
      await ensureProvidersRegistered();

      const provider = getAllProviders().find((p) => p.id === providerId);
      if (!provider) {
        res.status(404).send(`Unknown provider: ${providerId}`);
        return;
      }

      const setup = provider.authSetup?.();
      if (!setup?.oauthConfig) {
        res.status(400).send(`Provider ${providerId} does not use OAuth`);
        return;
      }

      // Providers with automatedLogin (e.g. Peloton) — run login server-side
      if (setup.automatedLogin) {
        const envPrefix = providerId.toUpperCase();
        const email = process.env[`${envPrefix}_USERNAME`];
        const password = process.env[`${envPrefix}_PASSWORD`];
        if (!email || !password) {
          res.status(400).send(`${envPrefix}_USERNAME and ${envPrefix}_PASSWORD must be set`);
          return;
        }

        console.log(`[auth] Running automated login for ${providerId}...`);
        const tokens = await setup.automatedLogin(email, password);
        const { ensureProvider, saveTokens } = await import("dofek/db/tokens");
        await ensureProvider(db, provider.id, provider.name, setup.apiBaseUrl);
        await saveTokens(db, provider.id, tokens);

        console.log(
          `[auth] ${providerId} tokens saved. Expires: ${tokens.expiresAt.toISOString()}`,
        );
        res.send(
          `<html><body style="font-family:system-ui;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h1>Authorized!</h1><p>${provider.name} connected successfully.</p><p>Token expires: ${tokens.expiresAt.toISOString()}</p><p><a href="/" style="color:#10b981">Return to dashboard</a></p></div></body></html>`,
        );
        return;
      }

      const { buildAuthorizationUrl } = await import("dofek/auth/oauth");
      const url = buildAuthorizationUrl(setup.oauthConfig);
      // Append state so the callback knows which provider this is for
      const authUrl = new URL(url);
      authUrl.searchParams.set("state", providerId);
      res.redirect(authUrl.toString());
    } catch (err: any) {
      console.error("[auth] Failed to start OAuth flow:", err);
      res.status(500).send(`Auth error: ${err.message}`);
    }
  });

  app.get("/callback", async (req, res) => {
    try {
      const code = req.query.code as string | undefined;
      const state = req.query.state as string | undefined;
      const error = req.query.error as string | undefined;

      if (error) {
        res.status(400).send(`Authorization denied: ${error}`);
        return;
      }
      if (!code || !state) {
        res.status(400).send("Missing code or state parameter");
        return;
      }

      const { getAllProviders } = await import("dofek/providers/registry");
      const { ensureProvidersRegistered } = await import("./routers/sync.js");
      await ensureProvidersRegistered();

      const provider = getAllProviders().find((p) => p.id === state);
      if (!provider) {
        res.status(404).send(`Unknown provider: ${state}`);
        return;
      }

      const setup = provider.authSetup?.();
      if (!setup?.oauthConfig || !setup.exchangeCode) {
        res.status(400).send(`Provider ${state} does not support OAuth code exchange`);
        return;
      }

      console.log(`[auth] Exchanging code for ${state} tokens...`);
      const tokens = await setup.exchangeCode(code);

      const { ensureProvider } = await import("dofek/db/tokens");
      const { saveTokens } = await import("dofek/db/tokens");
      await ensureProvider(db, provider.id, provider.name, setup.apiBaseUrl);
      await saveTokens(db, provider.id, tokens);

      console.log(`[auth] ${state} tokens saved. Expires: ${tokens.expiresAt.toISOString()}`);
      res.send(
        `<html><body style="font-family:system-ui;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h1>Authorized!</h1><p>${provider.name} connected successfully.</p><p>Token expires: ${tokens.expiresAt.toISOString()}</p><p><a href="/" style="color:#10b981">Return to dashboard</a></p></div></body></html>`,
      );
    } catch (err: any) {
      console.error("[auth] OAuth callback failed:", err);
      res.status(500).send(`Token exchange failed: ${err.message}`);
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
