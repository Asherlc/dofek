import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import compression from "compression";
import cookieParser from "cookie-parser";
import { createDatabaseFromEnv } from "dofek/db";
import { runMigrations } from "dofek/db/migrate";
import { DEFAULT_USER_ID } from "dofek/db/schema";
import type { SyncResult } from "dofek/providers/types";
import { sql } from "drizzle-orm";
import express from "express";
import {
  clearOAuthFlowCookies,
  clearSessionCookie,
  getOAuthFlowCookies,
  getSessionCookie,
  setOAuthFlowCookies,
  setSessionCookie,
} from "./auth/cookies.ts";
import {
  generateCodeVerifier,
  generateState,
  getConfiguredProviders,
  getIdentityProvider,
  type IdentityProviderName,
  isProviderConfigured,
} from "./auth/providers.ts";
import { createSession, deleteSession, validateSession } from "./auth/session.ts";
import { queryCache } from "./lib/cache.ts";
import { httpRequestDuration, registry } from "./lib/metrics.ts";
import { logger } from "./logger.ts";
import { appRouter } from "./router.ts";
import { startSlackBot } from "./slack/bot.ts";
import type { Context } from "./trpc.ts";

/** Max upload size: 2 GB */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Fire common queries sequentially to populate cache without overwhelming the DB.
 *  Uses DEFAULT_USER_ID for backwards compatibility — only warms for the primary user. */
async function warmCache(db: import("dofek/db").Database) {
  const caller = appRouter.createCaller({ db, userId: DEFAULT_USER_ID });
  const queries: Array<[string, () => Promise<unknown>]> = [
    // Dashboard
    ["dailyMetrics.list(30)", () => caller.dailyMetrics.list({ days: 30 })],
    ["dailyMetrics.list(90)", () => caller.dailyMetrics.list({ days: 90 })],
    ["dailyMetrics.trends(30)", () => caller.dailyMetrics.trends({ days: 30 })],
    ["dailyMetrics.latest", () => caller.dailyMetrics.latest()],
    ["sleep.list(30)", () => caller.sleep.list({ days: 30 })],
    ["sync.providers", () => caller.sync.providers()],
    ["sync.providerStats", () => caller.sync.providerStats()],
    ["insights.compute(90)", () => caller.insights.compute({ days: 90 })],
    // Training page
    ["training.weeklyVolume(90)", () => caller.training.weeklyVolume({ days: 90 })],
    ["training.hrZones(90)", () => caller.training.hrZones({ days: 90 })],
    ["pmc.chart(90)", () => caller.pmc.chart({ days: 90 })],
    ["power.powerCurve(90)", () => caller.power.powerCurve({ days: 90 })],
    ["power.eftpTrend(90)", () => caller.power.eftpTrend({ days: 90 })],
    // Cycling analytics page — warm all endpoints to avoid cold-cache 502s
    ["efficiency.aerobicEfficiency(180)", () => caller.efficiency.aerobicEfficiency({ days: 180 })],
    ["efficiency.polarizationTrend(180)", () => caller.efficiency.polarizationTrend({ days: 180 })],
    ["cyclingAdvanced.rampRate(90)", () => caller.cyclingAdvanced.rampRate({ days: 90 })],
    [
      "cyclingAdvanced.trainingMonotony(90)",
      () => caller.cyclingAdvanced.trainingMonotony({ days: 90 }),
    ],
    [
      "cyclingAdvanced.activityVariability(90)",
      () => caller.cyclingAdvanced.activityVariability({ days: 90 }),
    ],
    [
      "cyclingAdvanced.verticalAscentRate(90)",
      () => caller.cyclingAdvanced.verticalAscentRate({ days: 90 }),
    ],
  ];
  let ok = 0;
  for (const [name, fn] of queries) {
    try {
      await fn();
      ok++;
    } catch (err) {
      logger.error(`[cache] Failed to warm ${name}: ${err}`);
    }
  }
  logger.info(`[cache] Warmed ${ok}/${queries.length} queries`);
}

const PORT = parseInt(process.env.PORT ?? "3000", 10);

/** Stream a request body to a file on disk, enforcing a max size. */
function streamToFile(
  req: import("express").Request,
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

/** Create the Express app with all routes. Exported for testing. */
export function createApp(db: import("dofek/db").Database): express.Express {
  const app = express();
  setupRoutes(app, db);
  return app;
}

function setupRoutes(app: express.Express, db: import("dofek/db").Database) {
  // ── Compression + Cookies ──
  app.use(compression());
  app.use(cookieParser());

  // ── Prometheus metrics endpoint ──
  // Served at both /metrics (for Prometheus scraping) and /api/metrics (accessible through nginx /api/ proxy)
  const metricsHandler: import("express").RequestHandler = async (_req, res) => {
    res.set("Content-Type", registry.contentType);
    res.end(await registry.metrics());
  };
  app.get("/metrics", metricsHandler);
  app.get("/api/metrics", metricsHandler);

  // ── Request logging + metrics ──
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      const durationMs = Date.now() - start;
      const route = req.route?.path ?? req.originalUrl.split("?")[0];
      httpRequestDuration.observe(
        { method: req.method, route, status_code: res.statusCode },
        durationMs / 1000,
      );
      logger.info(`[web] ${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs}ms`);
    });
    next();
  });

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
    result?: SyncResult;
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
    logger.info("[apple-health] Starting import...");
    setJobStatus(jobId, { status: "processing", progress: 0, message: "Starting import..." });

    (async () => {
      const importStart = Date.now();
      try {
        const { importAppleHealthFile } = await import("dofek/providers/apple-health");
        let lastLoggedPct = 0;
        const result = await importAppleHealthFile(db, filePath, since, (info) => {
          setJobStatus(jobId, {
            status: "processing",
            progress: info.pct,
            message: `Processing: ${info.pct}%`,
          });
          // Log every 10% to avoid noise
          if (info.pct >= lastLoggedPct + 10) {
            logger.info(`[apple-health] Import progress: ${info.pct}%`);
            lastLoggedPct = info.pct;
          }
        });
        const durationSec = ((Date.now() - importStart) / 1000).toFixed(1);
        const msg = `${result.recordsSynced} records imported, ${result.errors?.length ?? 0} errors in ${durationSec}s`;
        logger.info(`[apple-health] Import complete: ${msg}`);
        setJobStatus(jobId, {
          status: "done",
          progress: 100,
          message: msg,
          result,
        });
        const { logSync } = await import("dofek/db/sync-log");
        await logSync(db, {
          providerId: "apple_health",
          dataType: "import",
          status: result.errors?.length ? "error" : "success",
          recordCount: result.recordsSynced,
          errorMessage: result.errors?.length
            ? result.errors.map((e) => e.message).join("; ")
            : undefined,
          durationMs: Date.now() - importStart,
        });
      } catch (err: unknown) {
        const message = errorMessage(err);
        logger.error(`[upload] Background import failed: ${message}`);
        setJobStatus(jobId, {
          status: "error",
          message,
        });
        try {
          const { logSync } = await import("dofek/db/sync-log");
          await logSync(db, {
            providerId: "apple_health",
            dataType: "import",
            status: "error",
            errorMessage: message,
            durationMs: Date.now() - importStart,
          });
        } catch (logErr) {
          logger.error(`[upload] Failed to log sync error: ${logErr}`);
        }
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
    const contentType = req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
    if (
      contentType &&
      !["application/octet-stream", "application/zip", "application/xml", "text/xml"].includes(
        contentType,
      )
    ) {
      res.status(415).json({
        error:
          "Unsupported Content-Type. Expected application/octet-stream, application/zip, application/xml, or text/xml",
      });
      return;
    }

    const uploadId = req.headers["x-upload-id"] as string | undefined;
    const chunkIndex = parseInt(req.headers["x-chunk-index"] as string, 10);
    const chunkTotal = parseInt(req.headers["x-chunk-total"] as string, 10);
    const fileExt = (req.headers["x-file-ext"] as string) || ".zip";
    const fullSync = req.query.fullSync === "true";

    // Validate uploadId and fileExt to prevent path traversal
    if (uploadId && !/^[a-zA-Z0-9_-]+$/.test(uploadId)) {
      res.status(400).json({ error: "Invalid upload ID" });
      return;
    }
    if (![".zip", ".xml"].includes(fileExt)) {
      res.status(400).json({ error: "Invalid file extension" });
      return;
    }
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
      } catch (err: unknown) {
        logger.error(`[upload] Apple Health upload failed: ${err}`);
        res.status(500).json({ error: "Upload failed" });
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
        // Clean up abandoned uploads after 30 minutes
        setTimeout(
          async () => {
            const stale = activeUploads.get(uploadId);
            if (stale) {
              activeUploads.delete(uploadId);
              await rm(stale.dir, { recursive: true, force: true }).catch(() => {});
              setJobStatus(uploadId, { status: "error", message: "Upload timed out" });
            }
          },
          30 * 60 * 1000,
        );
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
      logger.info(`[upload] Chunk ${chunkIndex + 1}/${chunkTotal} for ${uploadId}`);

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
    } catch (err: unknown) {
      logger.error(`[upload] Chunked upload failed: ${err}`);
      const upload = activeUploads.get(uploadId);
      if (upload) {
        activeUploads.delete(uploadId);
        await rm(upload.dir, { recursive: true, force: true }).catch(() => {});
      }
      setJobStatus(uploadId, { status: "error", message: "Upload failed" });
      res.status(500).json({ error: "Upload failed" });
    }
  });

  // ── Strong CSV upload ──
  app.get("/api/upload/strong-csv/status/:jobId", (req, res) => {
    const status = jobStatuses.get(req.params.jobId);
    if (!status) {
      res.status(404).json({ error: "Unknown job" });
      return;
    }
    res.json(status);
  });

  app.post("/api/upload/strong-csv", async (req, res) => {
    const contentType = req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
    if (
      contentType &&
      !["text/csv", "application/octet-stream", "text/plain"].includes(contentType)
    ) {
      res.status(415).json({
        error:
          "Unsupported Content-Type. Expected text/csv, application/octet-stream, or text/plain",
      });
      return;
    }

    const weightUnit = req.query.units === "lbs" ? "lbs" : "kg";
    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const tmpFile = join(tmpdir(), `strong-csv-${jobId}.csv`);

    try {
      await streamToFile(req, tmpFile);
      setJobStatus(jobId, {
        status: "processing",
        progress: 0,
        message: "Importing Strong CSV...",
      });
      res.json({ status: "processing", jobId });

      // Fire-and-forget background import
      (async () => {
        const importStart = Date.now();
        try {
          const { readFile } = await import("node:fs/promises");
          const csvText = await readFile(tmpFile, "utf-8");
          const { importStrongCsv } = await import("dofek/providers/strong-csv");
          const { DEFAULT_USER_ID } = await import("dofek/db/schema");
          const result = await importStrongCsv(
            db,
            csvText,
            DEFAULT_USER_ID,
            weightUnit as "kg" | "lbs",
          );

          const durationSec = ((Date.now() - importStart) / 1000).toFixed(1);
          const msg = `${result.recordsSynced} workouts imported, ${result.errors.length} errors in ${durationSec}s`;
          logger.info(`[strong-csv] Import complete: ${msg}`);
          setJobStatus(jobId, { status: "done", progress: 100, message: msg, result });

          const { logSync } = await import("dofek/db/sync-log");
          await logSync(db, {
            providerId: "strong-csv",
            dataType: "import",
            status: result.errors.length ? "error" : "success",
            recordCount: result.recordsSynced,
            errorMessage: result.errors.length
              ? result.errors.map((e) => e.message).join("; ")
              : undefined,
            durationMs: Date.now() - importStart,
          });
        } catch (err: unknown) {
          const message = errorMessage(err);
          logger.error(`[strong-csv] Import failed: ${message}`);
          setJobStatus(jobId, { status: "error", message });
        } finally {
          await unlink(tmpFile).catch(() => {});
        }
      })();
    } catch (err: unknown) {
      logger.error(`[strong-csv] Upload failed: ${err}`);
      res.status(500).json({ error: "Upload failed" });
    }
  });

  // ── Cronometer CSV upload ──
  app.get("/api/upload/cronometer-csv/status/:jobId", (req, res) => {
    const status = jobStatuses.get(req.params.jobId);
    if (!status) {
      res.status(404).json({ error: "Unknown job" });
      return;
    }
    res.json(status);
  });

  app.post("/api/upload/cronometer-csv", async (req, res) => {
    const contentType = req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
    if (
      contentType &&
      !["text/csv", "application/octet-stream", "text/plain"].includes(contentType)
    ) {
      res.status(415).json({
        error:
          "Unsupported Content-Type. Expected text/csv, application/octet-stream, or text/plain",
      });
      return;
    }

    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const tmpFile = join(tmpdir(), `cronometer-csv-${jobId}.csv`);

    try {
      await streamToFile(req, tmpFile);
      setJobStatus(jobId, {
        status: "processing",
        progress: 0,
        message: "Importing Cronometer CSV...",
      });
      res.json({ status: "processing", jobId });

      // Fire-and-forget background import
      (async () => {
        const importStart = Date.now();
        try {
          const { readFile } = await import("node:fs/promises");
          const csvText = await readFile(tmpFile, "utf-8");
          const { importCronometerCsv } = await import("dofek/providers/cronometer-csv");
          const result = await importCronometerCsv(db, csvText, DEFAULT_USER_ID);

          const durationSec = ((Date.now() - importStart) / 1000).toFixed(1);
          const msg = `${result.recordsSynced} food entries imported, ${result.errors.length} errors in ${durationSec}s`;
          logger.info(`[cronometer-csv] Import complete: ${msg}`);
          setJobStatus(jobId, { status: "done", progress: 100, message: msg, result });

          const { logSync } = await import("dofek/db/sync-log");
          await logSync(db, {
            providerId: "cronometer-csv",
            dataType: "import",
            status: result.errors.length ? "error" : "success",
            recordCount: result.recordsSynced,
            errorMessage: result.errors.length
              ? result.errors.map((e: { message: string }) => e.message).join("; ")
              : undefined,
            durationMs: Date.now() - importStart,
          });
        } catch (err: unknown) {
          const message = errorMessage(err);
          logger.error(`[cronometer-csv] Import failed: ${message}`);
          setJobStatus(jobId, { status: "error", message });
        } finally {
          await unlink(tmpFile).catch(() => {});
        }
      })();
    } catch (err: unknown) {
      logger.error(`[cronometer-csv] Upload failed: ${err}`);
      res.status(500).json({ error: "Upload failed" });
    }
  });

  // ── Data Export ──
  // Stores userId for each export job so we can verify ownership on download
  const exportJobOwners = new Map<string, string>();

  app.post("/api/export", async (req, res) => {
    const sessionId = getSessionCookie(req);
    if (!sessionId) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const session = await validateSession(db, sessionId);
    if (!session) {
      res.status(401).json({ error: "Session expired" });
      return;
    }

    const jobId = `export-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const tmpFile = join(tmpdir(), `dofek-export-${jobId}.zip`);

    setJobStatus(jobId, { status: "processing", progress: 0, message: "Starting export..." });
    exportJobOwners.set(jobId, session.userId);

    // Fire-and-forget background export
    (async () => {
      const exportStart = Date.now();
      try {
        const { generateExport } = await import("./export.ts");
        const result = await generateExport(db, session.userId, tmpFile, (info) => {
          setJobStatus(jobId, {
            status: "processing",
            progress: info.pct,
            message: info.message,
          });
        });

        const durationSec = ((Date.now() - exportStart) / 1000).toFixed(1);
        const msg = `Exported ${result.totalRecords} records across ${result.tableCount} tables in ${durationSec}s`;
        logger.info(`[export] ${msg}`);
        setJobStatus(jobId, { status: "done", progress: 100, message: msg });
      } catch (err: unknown) {
        const message = errorMessage(err);
        logger.error(`[export] Export failed: ${message}`);
        setJobStatus(jobId, { status: "error", message });
        await unlink(tmpFile).catch(() => {});
      }
    })();

    res.json({ status: "processing", jobId });
  });

  app.get("/api/export/status/:jobId", (req, res) => {
    const status = jobStatuses.get(req.params.jobId);
    if (!status) {
      res.status(404).json({ error: "Unknown job" });
      return;
    }
    const response: Record<string, unknown> = { ...status };
    if (status.status === "done") {
      response.downloadUrl = `/api/export/download/${req.params.jobId}`;
    }
    res.json(response);
  });

  app.get("/api/export/download/:jobId", async (req, res) => {
    const sessionId = getSessionCookie(req);
    if (!sessionId) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const session = await validateSession(db, sessionId);
    if (!session) {
      res.status(401).json({ error: "Session expired" });
      return;
    }

    const { jobId } = req.params;
    const status = jobStatuses.get(jobId);
    if (!status) {
      res.status(404).json({ error: "Unknown job" });
      return;
    }

    // Verify the export belongs to this user
    const ownerId = exportJobOwners.get(jobId);
    if (ownerId !== session.userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    if (status.status !== "done") {
      res.status(400).json({ error: "Export not ready" });
      return;
    }

    const filePath = join(tmpdir(), `dofek-export-${jobId}.zip`);
    try {
      await stat(filePath);
    } catch {
      res.status(404).json({ error: "Export file not found" });
      return;
    }

    res.download(filePath, "dofek-export.zip", (err) => {
      if (err) {
        logger.error(`[export] Download failed: ${err}`);
      }
      // Clean up the temp file after download
      unlink(filePath).catch(() => {});
      exportJobOwners.delete(jobId);
    });
  });

  // ── OAuth state ──
  // Maps random state tokens to provider IDs (+ optional PKCE verifier) for CSRF protection
  const oauthStateMap = new Map<
    string,
    { providerId: string; codeVerifier?: string; userId: string }
  >();
  // OAuth 1.0 request token secrets (keyed by oauth_token)
  const oauth1Secrets = new Map<
    string,
    { providerId: string; tokenSecret: string; userId: string }
  >();

  // ── Identity auth routes (login with Google, Apple, Authentik) ──

  const IDENTITY_PROVIDERS: IdentityProviderName[] = ["google", "apple", "authentik"];

  app.get("/api/auth/providers", (_req, res) => {
    res.json(getConfiguredProviders());
  });

  app.get("/auth/login/:provider", (req, res) => {
    try {
      const providerName = req.params.provider as IdentityProviderName;
      if (!IDENTITY_PROVIDERS.includes(providerName)) {
        res.status(404).send(`Unknown identity provider: ${providerName}`);
        return;
      }
      if (!isProviderConfigured(providerName)) {
        res.status(400).send(`Provider ${providerName} is not configured`);
        return;
      }

      const state = generateState();
      const codeVerifier = generateCodeVerifier();
      const provider = getIdentityProvider(providerName);

      // Encode the provider name in the state so the callback knows which provider
      const statePayload = `${providerName}:${state}`;
      const url = provider.createAuthorizationUrl(statePayload, codeVerifier);

      setOAuthFlowCookies(res, statePayload, codeVerifier);
      res.redirect(url.toString());
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[auth] Failed to start login flow: ${message}`);
      res.status(500).send("Auth error: failed to start login flow");
    }
  });

  app.get("/auth/callback/:provider", async (req, res) => {
    try {
      const providerName = req.params.provider as IdentityProviderName;
      if (!IDENTITY_PROVIDERS.includes(providerName)) {
        res.status(404).send(`Unknown identity provider: ${providerName}`);
        return;
      }

      const code = req.query.code as string | undefined;
      const stateParam = req.query.state as string | undefined;
      const error = req.query.error as string | undefined;

      if (error) {
        res.status(400).send(`Authorization denied: ${error}`);
        return;
      }
      if (!code || !stateParam) {
        res.status(400).send("Missing code or state parameter");
        return;
      }

      const { state: storedState, codeVerifier } = getOAuthFlowCookies(req);
      clearOAuthFlowCookies(res);

      if (!storedState || !codeVerifier || stateParam !== storedState) {
        res.status(400).send("Invalid state — please try logging in again");
        return;
      }

      // Validate the authorization code
      const provider = getIdentityProvider(providerName);
      const { user: identityUser } = await provider.validateCallback(code, codeVerifier);

      // Look up or create the user
      const existingAccount = await db.execute<{ user_id: string }>(
        sql`SELECT user_id FROM fitness.auth_account
            WHERE auth_provider = ${providerName} AND provider_account_id = ${identityUser.sub}
            LIMIT 1`,
      );

      let userId: string;

      const firstAccount = existingAccount[0];
      if (existingAccount.length > 0 && firstAccount) {
        userId = firstAccount.user_id;
      } else {
        // Check if this is the very first auth account (claim DEFAULT_USER_ID data)
        const accountCount = await db.execute<{ count: string }>(
          sql`SELECT COUNT(*)::text AS count FROM fitness.auth_account`,
        );
        const countRow = accountCount[0];
        if (!countRow) throw new Error("Failed to query account count");
        const isFirstUser = parseInt(countRow.count, 10) === 0;

        if (isFirstUser) {
          // First user — link to the default user profile and update it
          userId = DEFAULT_USER_ID;
          if (identityUser.email || identityUser.name) {
            await db.execute(
              sql`UPDATE fitness.user_profile
                  SET email = COALESCE(${identityUser.email}, email),
                      name = COALESCE(${identityUser.name}, name),
                      updated_at = NOW()
                  WHERE id = ${DEFAULT_USER_ID}`,
            );
          }
        } else {
          // New user — create a user profile
          const newUser = await db.execute<{ id: string }>(
            sql`INSERT INTO fitness.user_profile (name, email)
                VALUES (${identityUser.name ?? "User"}, ${identityUser.email})
                RETURNING id`,
          );
          const newUserRow = newUser[0];
          if (!newUserRow) throw new Error("Failed to create user profile");
          userId = newUserRow.id;
        }

        // Create the auth account link
        await db.execute(
          sql`INSERT INTO fitness.auth_account (user_id, auth_provider, provider_account_id, email, name)
              VALUES (${userId}, ${providerName}, ${identityUser.sub}, ${identityUser.email}, ${identityUser.name})`,
        );
      }

      // Create session
      const sessionInfo = await createSession(db, userId);
      setSessionCookie(res, sessionInfo.sessionId, sessionInfo.expiresAt);

      logger.info(`[auth] User ${userId} logged in via ${providerName}`);
      res.redirect("/");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[auth] Identity callback failed: ${message}`);
      res.status(500).send("Login failed — please try again");
    }
  });

  app.post("/auth/logout", async (req, res) => {
    const sessionId = getSessionCookie(req);
    if (sessionId) {
      await deleteSession(db, sessionId);
      clearSessionCookie(res);
    }
    res.json({ ok: true });
  });

  app.get("/api/auth/me", async (req, res) => {
    const sessionId = getSessionCookie(req);
    if (!sessionId) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const session = await validateSession(db, sessionId);
    if (!session) {
      clearSessionCookie(res);
      res.status(401).json({ error: "Session expired" });
      return;
    }
    const rows = await db.execute<{ id: string; name: string; email: string | null }>(
      sql`SELECT id, name, email FROM fitness.user_profile WHERE id = ${session.userId}`,
    );
    if (rows.length === 0) {
      res.status(401).json({ error: "User not found" });
      return;
    }
    res.json(rows[0]);
  });

  // ── Slack OAuth (Add to Slack) ──
  const SLACK_SCOPES = [
    "chat:write",
    "im:history",
    "im:read",
    "im:write",
    "users:read",
    "users:read.email",
  ];

  app.get("/auth/provider/slack", (_req, res) => {
    const clientId = process.env.SLACK_CLIENT_ID;
    if (!clientId) {
      res.status(400).send("SLACK_CLIENT_ID is not configured");
      return;
    }
    const redirectUri = `${process.env.OAUTH_REDIRECT_URI ?? ""}`;
    if (!redirectUri) {
      res.status(500).send("OAUTH_REDIRECT_URI must be configured");
      return;
    }
    const stateToken = `slack:${randomBytes(16).toString("hex")}`;
    oauthStateMap.set(stateToken, { providerId: "slack", userId: DEFAULT_USER_ID });
    setTimeout(() => oauthStateMap.delete(stateToken), 10 * 60 * 1000);
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("scope", SLACK_SCOPES.join(","));
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", stateToken);
    res.redirect(url.toString());
  });

  // ── Data-provider OAuth (Wahoo, Withings, etc.) ──
  app.get("/auth/provider/:provider", async (req, res) => {
    try {
      // Resolve the logged-in user so the provider record is linked to them
      const sessionId = getSessionCookie(req);
      const session = sessionId ? await validateSession(db, sessionId) : null;
      const userId = session?.userId ?? DEFAULT_USER_ID;

      const providerId = req.params.provider;
      const { getAllProviders } = await import("dofek/providers/registry");
      const { ensureProvidersRegistered } = await import("./routers/sync.ts");
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

        logger.info(`[auth] Running automated login for ${providerId}...`);
        const tokens = await setup.automatedLogin(email, password);
        const { ensureProvider, saveTokens } = await import("dofek/db/tokens");
        await ensureProvider(db, provider.id, provider.name, setup.apiBaseUrl, userId);
        await saveTokens(db, provider.id, tokens);
        await queryCache.invalidateByPrefix(`${userId}:sync.providers`);

        logger.info(
          `[auth] ${providerId} tokens saved. Expires: ${tokens.expiresAt.toISOString()}`,
        );
        res.send(
          `<html><body style="font-family:system-ui;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h1>Authorized!</h1><p>${provider.name} connected successfully.</p><p>Token expires: ${tokens.expiresAt.toISOString()}</p><p><a href="/" style="color:#10b981">Return to dashboard</a></p></div></body></html>`,
        );
        return;
      }

      // OAuth 1.0 providers (e.g. FatSecret) — get request token first
      if (setup.oauth1Flow) {
        const callbackUrl = `${process.env.OAUTH_REDIRECT_URI ?? ""}`;
        const result = await setup.oauth1Flow.getRequestToken(callbackUrl);
        oauth1Secrets.set(result.oauthToken, {
          providerId,
          tokenSecret: result.oauthTokenSecret,
          userId,
        });
        // Clean up after 10 minutes
        setTimeout(() => oauth1Secrets.delete(result.oauthToken), 10 * 60 * 1000);
        res.redirect(result.authorizeUrl);
        return;
      }

      const {
        buildAuthorizationUrl,
        generateCodeVerifier: genVerifier,
        generateCodeChallenge,
      } = await import("dofek/auth/oauth");

      // Generate PKCE challenge if the provider requires it
      let pkceVerifier: string | undefined;
      let pkceParam: { codeChallenge: string } | undefined;
      if (setup.oauthConfig.usePkce) {
        pkceVerifier = genVerifier();
        pkceParam = { codeChallenge: generateCodeChallenge(pkceVerifier) };
      }

      const url = buildAuthorizationUrl(setup.oauthConfig, pkceParam);
      // Generate random state for CSRF protection, map it to the provider ID + PKCE verifier
      const stateToken = randomBytes(16).toString("hex");
      oauthStateMap.set(stateToken, { providerId, codeVerifier: pkceVerifier, userId });
      setTimeout(() => oauthStateMap.delete(stateToken), 10 * 60 * 1000);
      const authUrl = new URL(url);
      authUrl.searchParams.set("state", stateToken);
      res.redirect(authUrl.toString());
    } catch (err: unknown) {
      logger.error(`[auth] Failed to start OAuth flow: ${err}`);
      res.status(500).send("Auth error: failed to start OAuth flow");
    }
  });

  app.get("/callback", async (req, res) => {
    try {
      const code = req.query.code as string | undefined;
      const state = req.query.state as string | undefined;
      const error = req.query.error as string | undefined;
      const oauthToken = req.query.oauth_token as string | undefined;
      const oauthVerifier = req.query.oauth_verifier as string | undefined;

      // Bare GET with no params — providers (e.g. Withings) verify the URL is reachable
      if (!code && !state && !error && !oauthToken) {
        res.send("OK");
        return;
      }

      if (error) {
        res.status(400).send(`Authorization denied: ${error}`);
        return;
      }

      // ── OAuth 1.0 callback (FatSecret) ──
      if (oauthToken && oauthVerifier) {
        const stored = oauth1Secrets.get(oauthToken);
        if (!stored) {
          res.status(400).send("Unknown or expired OAuth 1.0 request token");
          return;
        }
        oauth1Secrets.delete(oauthToken);

        const { getAllProviders } = await import("dofek/providers/registry");
        const { ensureProvidersRegistered } = await import("./routers/sync.ts");
        await ensureProvidersRegistered();

        const provider = getAllProviders().find((p) => p.id === stored.providerId);
        if (!provider) {
          res.status(404).send(`Unknown provider: ${stored.providerId}`);
          return;
        }

        const setup = provider.authSetup?.();
        if (!setup?.oauth1Flow) {
          res.status(400).send(`Provider ${stored.providerId} does not support OAuth 1.0`);
          return;
        }

        logger.info(`[auth] Exchanging OAuth 1.0 tokens for ${stored.providerId}...`);
        const { token, tokenSecret } = await setup.oauth1Flow.exchangeForAccessToken(
          oauthToken,
          stored.tokenSecret,
          oauthVerifier,
        );

        const { ensureProvider, saveTokens } = await import("dofek/db/tokens");
        await ensureProvider(db, provider.id, provider.name, undefined, stored.userId);
        // Store OAuth 1.0 tokens — token as accessToken, tokenSecret as refreshToken
        // OAuth 1.0 tokens don't expire
        await saveTokens(db, provider.id, {
          accessToken: token,
          refreshToken: tokenSecret,
          expiresAt: new Date("2099-12-31"),
          scopes: "",
        });
        await queryCache.invalidateByPrefix(`${stored.userId}:sync.providers`);

        logger.info(`[auth] ${stored.providerId} OAuth 1.0 tokens saved.`);
        res.send(
          `<html><body style="font-family:system-ui;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h1>Authorized!</h1><p>${provider.name} connected successfully.</p><p><a href="/" style="color:#10b981">Return to dashboard</a></p></div></body></html>`,
        );
        return;
      }

      // ── OAuth 2.0 callback ──
      if (!code || !state) {
        res.status(400).send("Missing code or state parameter");
        return;
      }

      // ── Slack OAuth callback (Add to Slack) ──
      if (state.startsWith("slack:") && oauthStateMap.has(state)) {
        oauthStateMap.delete(state);
        const clientId = process.env.SLACK_CLIENT_ID;
        const clientSecret = process.env.SLACK_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
          res.status(400).send("SLACK_CLIENT_ID and SLACK_CLIENT_SECRET must be set");
          return;
        }

        const redirectUri = `${process.env.OAUTH_REDIRECT_URI ?? ""}`;
        logger.info("[auth] Exchanging Slack OAuth code for bot token...");

        // Exchange code for access token via Slack's oauth.v2.access
        const tokenResponse = await fetch("https://slack.com/api/oauth.v2.access", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            code,
            redirect_uri: redirectUri,
          }),
        });
        const tokenData = (await tokenResponse.json()) as {
          ok: boolean;
          error?: string;
          team?: { id: string; name: string };
          access_token?: string;
          bot_user_id?: string;
          app_id?: string;
          authed_user?: { id: string };
        };

        if (!tokenData.ok || !tokenData.access_token || !tokenData.team?.id) {
          res.status(400).send(`Slack OAuth failed: ${tokenData.error ?? "unknown error"}`);
          return;
        }

        // Store the installation
        await db.execute(
          sql`INSERT INTO fitness.slack_installation (
                team_id, team_name, bot_token, bot_user_id, app_id,
                installer_slack_user_id, raw_installation
              ) VALUES (
                ${tokenData.team.id},
                ${tokenData.team.name ?? null},
                ${tokenData.access_token},
                ${tokenData.bot_user_id ?? null},
                ${tokenData.app_id ?? null},
                ${tokenData.authed_user?.id ?? null},
                ${JSON.stringify(tokenData)}::jsonb
              )
              ON CONFLICT (team_id) DO UPDATE SET
                team_name = EXCLUDED.team_name,
                bot_token = EXCLUDED.bot_token,
                bot_user_id = EXCLUDED.bot_user_id,
                app_id = EXCLUDED.app_id,
                installer_slack_user_id = EXCLUDED.installer_slack_user_id,
                raw_installation = EXCLUDED.raw_installation,
                updated_at = NOW()`,
        );

        logger.info(
          `[auth] Slack installed for team ${tokenData.team.id} (${tokenData.team.name})`,
        );
        res.send(
          `<html><body style="font-family:system-ui;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h1>Slack Connected!</h1><p>Bot added to <strong>${tokenData.team.name}</strong>.</p><p>Send me a DM about what you ate!</p><p><a href="/" style="color:#10b981">Return to dashboard</a></p></div></body></html>`,
        );
        return;
      }

      // Resolve provider from random state token
      const stateEntry = oauthStateMap.get(state);
      if (!stateEntry) {
        res.status(400).send("Unknown or expired OAuth state");
        return;
      }
      oauthStateMap.delete(state);

      const { providerId, codeVerifier: storedCodeVerifier, userId: stateUserId } = stateEntry;

      const { getAllProviders } = await import("dofek/providers/registry");
      const { ensureProvidersRegistered } = await import("./routers/sync.ts");
      await ensureProvidersRegistered();

      const provider = getAllProviders().find((p) => p.id === providerId);
      if (!provider) {
        res.status(404).send(`Unknown provider: ${providerId}`);
        return;
      }

      const setup = provider.authSetup?.();
      if (!setup?.oauthConfig || !setup.exchangeCode) {
        res.status(400).send(`Provider ${providerId} does not support OAuth code exchange`);
        return;
      }

      logger.info(`[auth] Exchanging code for ${providerId} tokens...`);
      const tokens = await setup.exchangeCode(code, storedCodeVerifier);

      const { ensureProvider } = await import("dofek/db/tokens");
      const { saveTokens } = await import("dofek/db/tokens");
      await ensureProvider(db, provider.id, provider.name, setup.apiBaseUrl, stateUserId);
      await saveTokens(db, provider.id, tokens);
      await queryCache.invalidateByPrefix(`${stateUserId}:sync.providers`);

      logger.info(`[auth] ${providerId} tokens saved. Expires: ${tokens.expiresAt.toISOString()}`);
      res.send(
        `<html><body style="font-family:system-ui;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h1>Authorized!</h1><p>${provider.name} connected successfully.</p><p>Token expires: ${tokens.expiresAt.toISOString()}</p><p><a href="/" style="color:#10b981">Return to dashboard</a></p></div></body></html>`,
      );
    } catch (err: unknown) {
      logger.error(`[auth] OAuth callback failed: ${err}`);
      res.status(500).send("Token exchange failed");
    }
  });

  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext: async ({ req }): Promise<Context> => {
        const sessionId = getSessionCookie(req);
        const session = sessionId ? await validateSession(db, sessionId) : null;
        return { db, userId: session?.userId ?? null };
      },
      allowMethodOverride: true,
    }),
  );
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  // Auto-run pending migrations on startup
  await runMigrations(databaseUrl);

  const db = createDatabaseFromEnv();
  const app = createApp(db);

  app.listen(PORT, () => {
    logger.info(`[server] API running at http://localhost:${PORT}`);
    logger.info(`[server] tRPC at http://localhost:${PORT}/api/trpc`);

    // Warm cache with common dashboard queries (fire-and-forget)
    warmCache(db).catch((err) => logger.error(`[cache] Warm failed: ${err}`));

    // Start Slack bot if configured (fire-and-forget)
    startSlackBot(db, app).catch((err) => logger.error(`[slack] Slack bot error: ${err}`));
  });
}

// Only start server when run directly (not imported for testing)
const isDirectRun =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));
if (isDirectRun) {
  main().catch((err: unknown) => {
    logger.error(`[web] Failed to start: ${err}`);
    process.exit(1);
  });
}
