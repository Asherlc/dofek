import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import * as Sentry from "@sentry/node";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import compression from "compression";
import cookieParser from "cookie-parser";
import { createDatabaseFromEnv } from "dofek/db";
import { createImportQueue, createSyncQueue } from "dofek/jobs/queues";
import { createR2Client, createS3Client, parseR2Config } from "dofek/lib/r2-client";
import { sql } from "drizzle-orm";
import express from "express";
import { isAdmin } from "./auth/admin.ts";
import { getSessionIdFromRequest } from "./auth/cookies.ts";
import { validateSession } from "./auth/session.ts";
import { httpRequestDuration, registry } from "./lib/metrics.ts";
import { initSentry, sentryErrorHandler } from "./lib/sentry.ts";
import { warmCache } from "./lib/warm-cache.ts";
import { logger } from "./logger.ts";
import { appRouter } from "./router.ts";
import { createAuthRouter } from "./routes/auth.ts";
import { createExportRouter } from "./routes/export.ts";
import { createUpdatesRouter } from "./routes/updates.ts";
import { createUploadRouter } from "./routes/upload.ts";
import { createWebhookRouter } from "./routes/webhooks.ts";
import { startSlackBot } from "./slack/bot.ts";
import type { Context } from "./trpc.ts";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

function getSingleHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }
  return undefined;
}

/** Create the Express app with all routes. Exported for testing. */
export function createApp(db: import("dofek/db").Database): express.Express {
  initSentry();
  const app = express();
  setupRoutes(app, db);
  // Sentry error handler must be after all routes
  app.use(sentryErrorHandler());
  return app;
}

function setupRoutes(app: express.Express, db: import("dofek/db").Database) {
  // ── Health check (before all middleware — no logging, no auth) ──
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

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

  // ── BullMQ queues (lazy init — deferred until first use to avoid Redis
  //    connection attempts in test environments) ──
  let _importQueue: ReturnType<typeof createImportQueue> | null = null;
  let _syncQueue: ReturnType<typeof createSyncQueue> | null = null;

  function getImportQueue() {
    if (!_importQueue) _importQueue = createImportQueue();
    return _importQueue;
  }

  function getSyncQueue() {
    if (!_syncQueue) _syncQueue = createSyncQueue();
    return _syncQueue;
  }

  // ── Bull Board dashboard (admin-only) ──
  const bullBoardAdapter = new ExpressAdapter();
  bullBoardAdapter.setBasePath("/admin/queues");
  const lazyBullBoard = { initialized: false };
  app.use("/admin/queues", async (req, res, next) => {
    // Require authenticated admin user
    const sessionId = getSessionIdFromRequest(req);
    if (!sessionId) {
      res.status(401).send("Authentication required");
      return;
    }
    const session = await validateSession(db, sessionId);
    if (!session) {
      res.status(401).send("Session expired");
      return;
    }
    const admin = await isAdmin(db, session.userId);
    if (!admin) {
      res.status(403).send("Admin access required");
      return;
    }

    if (!lazyBullBoard.initialized) {
      createBullBoard({
        queues: [new BullMQAdapter(getSyncQueue()), new BullMQAdapter(getImportQueue())],
        serverAdapter: bullBoardAdapter,
      });
      lazyBullBoard.initialized = true;
    }
    bullBoardAdapter.getRouter()(req, res, next);
  });

  const updatesStorage = (() => {
    const endpoint = process.env.R2_ENDPOINT;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const bucket = process.env.R2_BUCKET;
    const hasSomeR2Config = [endpoint, accessKeyId, secretAccessKey, bucket].some(Boolean);
    const hasCompleteR2Config = [endpoint, accessKeyId, secretAccessKey, bucket].every(Boolean);

    if (!hasSomeR2Config) return null;
    if (!hasCompleteR2Config) {
      logger.error("[updates] Incomplete R2 config; falling back to filesystem OTA storage");
      return null;
    }

    try {
      const config = parseR2Config({
        R2_ENDPOINT: endpoint,
        R2_ACCESS_KEY_ID: accessKeyId,
        R2_SECRET_ACCESS_KEY: secretAccessKey,
        R2_BUCKET: bucket,
      });
      logger.info("[updates] Using R2 object storage for OTA assets");
      return createR2Client(createS3Client(config), config.R2_BUCKET);
    } catch (error) {
      logger.error(`[updates] Invalid R2 config; falling back to filesystem OTA storage: ${error}`);
      Sentry.captureException(error);
      return null;
    }
  })();

  const updatesRouter = createUpdatesRouter({
    updatesDir: process.env.UPDATES_DIR ?? "/app/updates",
    updatesStorage: updatesStorage ?? undefined,
    updatesPrefix: process.env.UPDATES_R2_PREFIX ?? "mobile-ota",
    publicUrl: process.env.PUBLIC_URL ?? "https://dofek.asherlc.com",
    signingPrivateKey: process.env.OTA_SIGNING_PRIVATE_KEY,
  });

  // ── Route modules ──
  // Webhook routes must be mounted before json() middleware — they use raw body for HMAC verification
  app.use("/api/webhooks", createWebhookRouter({ db, getSyncQueue }));
  app.use("/api/upload", createUploadRouter({ getImportQueue, db }));
  app.use("/api/export", createExportRouter(db));
  app.use("/api/updates", updatesRouter);
  app.use("/updates", updatesRouter);
  // ── Dev-only: auto-login for seed database testing ──
  if (process.env.NODE_ENV !== "production") {
    app.get("/auth/dev-login", async (_req, res) => {
      const { setSessionCookie } = await import("./auth/cookies.ts");
      const rows = await db.execute<{ id: string; expires_at: Date }>(
        sql`SELECT id, expires_at FROM fitness.session WHERE id = 'dev-session' LIMIT 1`,
      );
      const row = rows[0];
      if (!row) {
        res.status(404).send("No dev-session found. Run pnpm seed first.");
        return;
      }
      setSessionCookie(res, row.id, new Date(row.expires_at));
      res.redirect("/dashboard");
    });
  }

  app.use(createAuthRouter(db));

  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext: async ({ req }): Promise<Context> => {
        const sessionId = getSessionIdFromRequest(req);
        const session = sessionId ? await validateSession(db, sessionId) : null;
        const timezone = getSingleHeaderValue(req.headers["x-timezone"]) ?? "UTC";
        const appVersion = getSingleHeaderValue(req.headers["x-app-version"]);
        const assetsVersion = getSingleHeaderValue(req.headers["x-assets-version"]);
        return { db, userId: session?.userId ?? null, timezone, appVersion, assetsVersion };
      },
      onError: ({ path, error }) => {
        logger.error(`[trpc] ${path}: ${error.message}`);
      },
      allowMethodOverride: true,
    }),
  );
}

/**
 * Fire-and-forget startup tasks. Exported for testability.
 * Errors are logged and reported to Sentry but don't crash the server.
 */
export function runStartupTasks(
  db: ReturnType<typeof createDatabaseFromEnv>,
  app: express.Express,
) {
  warmCache(db).catch((err) => {
    logger.error(`[cache] Warm failed: ${err}`);
    Sentry.captureException(err);
  });

  startSlackBot(db, app).catch((err) => {
    logger.error(`[slack] Slack bot error: ${err}`);
    Sentry.captureException(err);
  });
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  const db = createDatabaseFromEnv();
  const app = createApp(db);

  app.listen(PORT, () => {
    logger.info(`[server] API running at http://localhost:${PORT}`);
    logger.info(`[server] tRPC at http://localhost:${PORT}/api/trpc`);
    runStartupTasks(db, app);
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
