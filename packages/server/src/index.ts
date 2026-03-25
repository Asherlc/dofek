import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import compression from "compression";
import cookieParser from "cookie-parser";
import { createDatabaseFromEnv } from "dofek/db";
import { createImportQueue, createSyncQueue } from "dofek/jobs/queues";
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

  // ── Route modules ──
  // Webhook routes must be mounted before json() middleware — they use raw body for HMAC verification
  app.use("/api/webhooks", createWebhookRouter({ db, getSyncQueue }));
  app.use("/api/upload", createUploadRouter({ getImportQueue, db }));
  app.use("/api/export", createExportRouter(db));
  app.use(
    "/api/updates",
    createUpdatesRouter({
      updatesDir: process.env.UPDATES_DIR ?? "/app/updates",
      publicUrl: process.env.PUBLIC_URL ?? "https://dofek.asherlc.com",
    }),
  );
  app.use(createAuthRouter(db));

  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext: async ({ req }): Promise<Context> => {
        const sessionId = getSessionIdFromRequest(req);
        const session = sessionId ? await validateSession(db, sessionId) : null;
        const rawTimezone = req.headers["x-timezone"];
        const timezone = typeof rawTimezone === "string" ? rawTimezone : "UTC";
        return { db, userId: session?.userId ?? null, timezone };
      },
      onError: ({ path, error }) => {
        logger.error(`[trpc] ${path}: ${error.message}`);
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
