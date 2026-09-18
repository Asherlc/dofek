import { existsSync, readFileSync } from "node:fs";
import type http from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { constants as zlibConstants } from "node:zlib";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { TRPCError } from "@trpc/server";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import compression from "compression";
import cookieParser from "cookie-parser";
import { createDatabaseFromEnv } from "dofek/db";
import { bootstrapClickHouseFromEnv, createClickHouseClientFromEnv } from "dofek/db/clickhouse";
import {
  createActivityDeleteAnalyticsQueue,
  createExportQueue,
  createFitFileImportBatchQueue,
  createFitFileImportQueue,
  createPostSyncQueue,
  createScheduledSyncQueue,
  createSyncQueue,
  createZipEntryExtractQueue,
  getImportQueue,
} from "dofek/jobs/queues";
import { captureException } from "dofek/lib/error-reporting";
import { getAllProviders } from "dofek/providers/registry";
import { sql } from "drizzle-orm";
import express from "express";
import { validateAccountErasureLedgerKeyring } from "../../../src/account-erasure/identity.ts";
import { createEncryptedAccountErasureSnapshot } from "../../../src/account-erasure/remote-snapshot.ts";
import {
  type AccountErasureRestoreLedger,
  createAccountErasureRestoreLedgerFromEnv,
  createLazyAccountErasureRestoreLedger,
} from "../../../src/account-erasure/restore-ledger.ts";
import { reconcileAccountErasureRestoreIntents } from "../../../src/account-erasure/restore-reconciliation.ts";
import {
  getDefaultMetricStreamEventPublisher,
  type MetricStreamEventPublisher,
} from "../../../src/metric-stream/redpanda-producer.ts";
import { isAdmin } from "./auth/admin.ts";
import { getSessionIdFromRequest } from "./auth/cookies.ts";
import { validateSession } from "./auth/session.ts";
import { getAccessWindowForUser } from "./billing/access-window-repository.ts";
import { httpRequestDuration, registry } from "./lib/metrics.ts";
import { checkReadiness } from "./lib/readiness.ts";
import { requestTimezoneSchema } from "./lib/request-timezone.ts";
import { initSentry, sentryErrorHandler } from "./lib/sentry.ts";
import { logger } from "./logger.ts";
import { createMcpOAuthRouter, type McpAuthRateLimitOptions } from "./mcp/oauth-route.ts";
import { createMcpRouter } from "./mcp/route.ts";
import { BillingProfileNotFoundError } from "./repositories/billing-repository.ts";
import { ClickHouseActivitySensorStore } from "./repositories/clickhouse-activity-sensor-store.ts";
import { DeveloperClientRepository } from "./repositories/developer-client-repository.ts";
import { LimitedActivitySensorStore } from "./repositories/limited-activity-sensor-store.ts";
import { appRouter } from "./router.ts";
import { ensureProvidersRegistered } from "./routers/sync-helpers.ts";
import { createActivityExportRouter } from "./routes/activity-export.ts";
import { createAppStoreWebhookRouter } from "./routes/app-store-webhook.ts";
import { createAuthRouter } from "./routes/auth/index.ts";
import { authRateLimiter } from "./routes/auth/shared.ts";
import { createCompanionPairingRouter } from "./routes/companion-pairing.ts";
import { createCompanionTokenHttpRouter } from "./routes/companion-token.ts";
import { createDeveloperClientsRouter } from "./routes/developer-clients.ts";
import { createExportRouter } from "./routes/export.ts";
import { createExternalWriteApiRouter } from "./routes/external-write-api.ts";
import { createIngestZosHealthRouter } from "./routes/ingest-zos-health.ts";
import { createIngestZosImuRouter } from "./routes/ingest-zos-imu.ts";
import { createOpenAiAppsChallengeRouter } from "./routes/openai-apps-challenge.ts";
import { createStripeWebhookRouter } from "./routes/stripe-webhook.ts";
import { createWebhookRouter } from "./routes/webhooks.ts";
import type { Context } from "./trpc.ts";

export function onUnhandledRejection(reason: unknown): void {
  const error = reason instanceof Error ? reason : new Error(String(reason));

  if (reason instanceof DOMException && reason.name === "AbortError") {
    logger.error(`[web] Ignoring AbortError from client disconnect: ${error.message}`);
    return;
  }

  logger.error(`[web] Unhandled rejection: ${error.message}`);
  captureException(error);

  setImmediate(() => {
    process.exit(1);
  });
}

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const WEB_DIST_PATH = fileURLToPath(new URL("../../web/dist", import.meta.url));

// A rolling Swarm deploy stops the old `web` container while Traefik may still be
// routing new requests to it. Traefik's own loadbalancer healthcheck (not the
// container healthcheck at /readyz) is what decides whether it keeps sending
// traffic here, so on SIGTERM we fail /healthz immediately, wait long enough for
// Traefik to notice (a few of its 5s healthcheck intervals) and stop routing, then
// stop accepting new connections and let in-flight requests finish.
const SHUTDOWN_HEALTHCHECK_DRAIN_MS = 10_000;
const SHUTDOWN_FORCE_EXIT_AFTER_MS = 20_000;

export interface GracefulShutdownOptions {
  server: { close: (callback: (err?: Error) => void) => unknown };
  markShuttingDown: () => void;
  drainDelayMs?: number;
  forceExitAfterMs?: number;
  onExit?: (code: number) => void;
}

/** Builds a SIGTERM/SIGINT handler that drains in-flight requests before exiting. */
export function createGracefulShutdownHandler(
  options: GracefulShutdownOptions,
): (signal: NodeJS.Signals) => void {
  const drainDelayMs = options.drainDelayMs ?? SHUTDOWN_HEALTHCHECK_DRAIN_MS;
  const forceExitAfterMs = options.forceExitAfterMs ?? SHUTDOWN_FORCE_EXIT_AFTER_MS;
  const exit = options.onExit ?? ((code: number) => process.exit(code));
  let shuttingDown = false;

  return (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    options.markShuttingDown();
    logger.info(`[server] Received ${signal}, draining before shutdown`);

    const forceExitTimer = setTimeout(() => {
      logger.error("[server] Graceful shutdown timed out, forcing exit");
      exit(1);
    }, drainDelayMs + forceExitAfterMs);
    forceExitTimer.unref();

    const closeTimer = setTimeout(() => {
      options.server.close((err) => {
        clearTimeout(forceExitTimer);
        if (err) {
          logger.error(`[server] Error while closing server: ${err.message}`);
          exit(1);
          return;
        }
        logger.info("[server] Shutdown complete");
        exit(0);
      });
    }, drainDelayMs);
    closeTimer.unref();
  };
}

function getSingleHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }
  return undefined;
}

/** Create the Express app with all routes. */
export interface CreateAppOptions {
  accountErasureRestoreLedger?: AccountErasureRestoreLedger;
  metricStreamPublisher?: MetricStreamEventPublisher;
  mcpAuthRateLimit?: McpAuthRateLimitOptions;
  openAiAppsChallengeToken?: string;
  /** Reports true once a SIGTERM/SIGINT drain has started, so /healthz can fail fast. */
  isShuttingDown?: () => boolean;
}

export function createApp(
  db: import("dofek/db").Database,
  sensorStore: import("./repositories/activity-repository.ts").ActivitySensorStore,
  options: CreateAppOptions = {},
): express.Express {
  initSentry();
  const app = express();
  const accountErasureRestoreLedger =
    options.accountErasureRestoreLedger ?? createLazyAccountErasureRestoreLedger();
  const openAiAppsChallengeToken = (
    options.openAiAppsChallengeToken ?? process.env.OPENAI_APPS_CHALLENGE_TOKEN
  )?.trim();
  if (!openAiAppsChallengeToken) {
    throw new Error("OPENAI_APPS_CHALLENGE_TOKEN environment variable is required");
  }
  app.set("trust proxy", 1);
  const limitedSensorStore = new LimitedActivitySensorStore(sensorStore);

  // ── Health check (before ALL middleware and other routes) ──
  // Traefik's loadbalancer healthcheck polls this to decide whether to keep
  // routing traffic here — it must fail as soon as a graceful shutdown starts.
  app.get("/healthz", (_req, res) => {
    if (options.isShuttingDown?.()) {
      res.status(503).json({ status: "shutting_down" });
      return;
    }
    res.json({ status: "ok" });
  });

  app.get("/readyz", async (_req, res) => {
    const result = await checkReadiness({ db, sensorStore });
    res.status(result.status === "ok" ? 200 : 503).json(result);
  });

  app.use("/.well-known", createOpenAiAppsChallengeRouter(openAiAppsChallengeToken));

  setupRoutes(app, db, limitedSensorStore, options, accountErasureRestoreLedger);
  // Catch malformed percent-encoded URL params (e.g. %C0) before Sentry sees them.
  // These come from scanners/bots and are not application errors.
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (err instanceof URIError) {
        res.status(400).send("Bad Request");
        return;
      }
      next(err);
    },
  );
  // Sentry error handler must be after all routes
  app.use(sentryErrorHandler());
  return app;
}

function setupRoutes(
  app: express.Express,
  db: import("dofek/db").Database,
  sensorStore: import("./repositories/activity-repository.ts").ActivitySensorStore,
  options: CreateAppOptions,
  accountErasureRestoreLedger: AccountErasureRestoreLedger,
) {
  // ── Compression + Cookies ──
  // Z_SYNC_FLUSH ensures compressed chunks are flushed to the client immediately,
  // which is required for tRPC's httpBatchStreamLink to deliver results incrementally.
  // Without this, the default Z_NO_FLUSH buffers data until the internal zlib buffer
  // fills (~16KB), making streamed responses appear to hang until all queries complete.
  app.use(compression({ flush: zlibConstants.Z_SYNC_FLUSH }));
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
    let logPathSearch = req.originalUrl;
    try {
      const logUrl = new URL(req.originalUrl, "http://localhost");
      for (const sensitiveParameter of ["session", "code"]) {
        if (logUrl.searchParams.has(sensitiveParameter)) {
          logUrl.searchParams.set(sensitiveParameter, "[REDACTED]");
        }
      }
      logPathSearch = `${logUrl.pathname}${logUrl.search}`;
    } catch (error: unknown) {
      captureException(error, { tags: { context: "request-url-logging" } });
    }
    res.on("finish", () => {
      const durationMs = Date.now() - start;
      const route = req.route?.path ?? req.originalUrl.split("?")[0];
      httpRequestDuration.observe(
        { method: req.method, route, status_code: res.statusCode },
        durationMs / 1000,
      );
      logger.info(`[web] ${req.method} ${logPathSearch} ${res.statusCode} ${durationMs}ms`);
    });
    next();
  });

  // ── BullMQ queues ──
  const importQueue = getImportQueue();
  const fitFileImportQueue = createFitFileImportQueue();
  const fitFileImportBatchQueue = createFitFileImportBatchQueue();
  const zipEntryExtractQueue = createZipEntryExtractQueue();
  const syncQueue = createSyncQueue();
  const exportQueue = createExportQueue();
  const scheduledSyncQueue = createScheduledSyncQueue();
  const postSyncQueue = createPostSyncQueue();
  const activityDeleteAnalyticsQueue = createActivityDeleteAnalyticsQueue();

  // ── Bull Board dashboard (admin-only) ──
  const bullBoardAdapter = new ExpressAdapter();
  bullBoardAdapter.setBasePath("/admin/queues");
  createBullBoard({
    queues: [
      new BullMQAdapter(syncQueue),
      new BullMQAdapter(importQueue),
      new BullMQAdapter(fitFileImportQueue),
      new BullMQAdapter(fitFileImportBatchQueue),
      new BullMQAdapter(zipEntryExtractQueue),
      new BullMQAdapter(exportQueue),
      new BullMQAdapter(scheduledSyncQueue),
      new BullMQAdapter(postSyncQueue),
      new BullMQAdapter(activityDeleteAnalyticsQueue),
    ],
    serverAdapter: bullBoardAdapter,
  });
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

    bullBoardAdapter.getRouter()(req, res, next);
  });

  // ── Route modules ──
  // Webhook routes must be mounted before JSON middleware because signature verification uses raw bodies.
  app.use("/api/webhooks/app-store", createAppStoreWebhookRouter({ db }));
  app.use("/api/webhooks/stripe", createStripeWebhookRouter({ db }));
  app.use("/api/webhooks", createWebhookRouter({ db, syncQueue }));
  app.use("/api/export", createExportRouter({ db, exportQueue }));
  app.use(
    "/api/developer/clients",
    createDeveloperClientsRouter({
      db,
      repository: new DeveloperClientRepository(db),
    }),
  );
  app.use("/api/external/v1", createExternalWriteApiRouter({ db }));
  app.use("/api/activity", createActivityExportRouter({ db, sensorStore }));
  app.use(createMcpOAuthRouter(db, options.mcpAuthRateLimit));
  app.use("/api/mcp", createMcpRouter({ db, sensorStore }));
  app.use("/api/ingest", createIngestZosHealthRouter({ db }));
  app.use("/api/ingest", createIngestZosImuRouter({ db }));
  app.use("/api/companion-pairing/start", authRateLimiter);
  app.use("/api/companion-pairing", createCompanionPairingRouter({ db }));
  app.use("/api/companion-token", createCompanionTokenHttpRouter({ db }));
  // ── Seeded-login helper for local dev and preview environments ──
  if (process.env.NODE_ENV !== "production" || process.env.ENABLE_DEV_LOGIN === "true") {
    app.get("/auth/dev-login", async (_req, res) => {
      const { setSessionCookie } = await import("./auth/cookies.ts");
      const rows = await db.execute<{ id: string; expires_at: string }>(
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
        const timezoneResult = requestTimezoneSchema.safeParse(
          getSingleHeaderValue(req.headers["x-timezone"]),
        );
        if (!timezoneResult.success) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid x-timezone header" });
        }
        const timezone = timezoneResult.data;
        const appVersion = getSingleHeaderValue(req.headers["x-app-version"]);
        const assetsVersion = getSingleHeaderValue(req.headers["x-assets-version"]);
        let accessWindow: Context["accessWindow"];
        try {
          accessWindow = session
            ? await getAccessWindowForUser(db, session.userId, timezone)
            : undefined;
        } catch (error) {
          if (error instanceof BillingProfileNotFoundError) {
            throw new TRPCError({ code: "NOT_FOUND", message: error.message });
          }
          throw error;
        }
        return {
          accountErasureRestoreLedger,
          db,
          sensorStore,
          metricStreamPublisher: options.metricStreamPublisher,
          userId: session?.userId ?? null,
          authenticatedAt: session?.authenticatedAt,
          timezone,
          appVersion,
          assetsVersion,
          accessWindow,
        };
      },
      onError: ({ path, error }) => {
        logger.error(`[trpc] ${path}: ${error.message}`);
        if (error.code === "INTERNAL_SERVER_ERROR") {
          captureException(error.cause ?? error, { tags: { trpcPath: path } });
        }
      },
      allowMethodOverride: true,
    }),
  );

  // ── Static files + SPA fallback (production: built web assets) ──
  const webDistPath = WEB_DIST_PATH;
  if (existsSync(webDistPath)) {
    const indexPath = join(webDistPath, "index.html");
    const indexHtml = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : null;

    // Vite-hashed assets — cache aggressively
    app.use(
      "/assets",
      express.static(join(webDistPath, "assets"), { maxAge: "1y", immutable: true }),
    );
    app.use("/assets", (_req, res) => {
      res.status(404).send("Not Found");
    });

    // Other static files (favicon, manifest, etc.)
    app.use(express.static(webDistPath, { index: false }));

    if (indexHtml) {
      // SPA fallback — serve the built index shell for non-API GET requests.
      app.get("/{*path}", (req, res, next) => {
        if (
          req.path.startsWith("/api/") ||
          req.path.startsWith("/auth/") ||
          req.path.startsWith("/admin/queues") ||
          extname(req.path) !== ""
        ) {
          next();
          return;
        }
        res.set("Cache-Control", "no-cache");
        res.type("html").send(indexHtml);
      });
    }
  }
}

export interface MainResult {
  server: http.Server;
  markShuttingDown: () => void;
}

/** Validate env, create app, and start listening. */
export async function main(): Promise<MainResult> {
  initSentry();
  const openAiAppsChallengeToken = process.env.OPENAI_APPS_CHALLENGE_TOKEN?.trim();
  if (!openAiAppsChallengeToken) {
    throw new Error("OPENAI_APPS_CHALLENGE_TOKEN environment variable is required");
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  const clickHouseUrl = process.env.CLICKHOUSE_URL;
  if (!clickHouseUrl) {
    throw new Error("CLICKHOUSE_URL environment variable is required");
  }
  validateAccountErasureLedgerKeyring();
  const accountErasureRestoreLedger = createAccountErasureRestoreLedgerFromEnv();
  const db = createDatabaseFromEnv();
  await ensureProvidersRegistered();
  await reconcileAccountErasureRestoreIntents({
    createEncryptedRemoteSnapshot: (transaction, userId) =>
      createEncryptedAccountErasureSnapshot(transaction, userId, getAllProviders()),
    database: db,
    ledger: accountErasureRestoreLedger,
  });
  const metricStreamPublisher = await getDefaultMetricStreamEventPublisher();
  const clickHouseClient = createClickHouseClientFromEnv();
  await bootstrapClickHouseFromEnv(clickHouseClient);
  const sensorStore = new ClickHouseActivitySensorStore(clickHouseClient);
  let shuttingDown = false;
  const app = createApp(db, sensorStore, {
    accountErasureRestoreLedger,
    metricStreamPublisher,
    openAiAppsChallengeToken,
    isShuttingDown: () => shuttingDown,
  });

  const server = app.listen(PORT, () => {
    logger.info(`[server] API running at http://localhost:${PORT}`);
    logger.info(`[server] tRPC at http://localhost:${PORT}/api/trpc`);
  });

  return {
    server,
    markShuttingDown: () => {
      shuttingDown = true;
    },
  };
}

// Only start server when run directly (not imported for testing)
const isDirectRun =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));
if (isDirectRun) {
  process.on("unhandledRejection", onUnhandledRejection);
  main()
    .then(({ server, markShuttingDown }) => {
      const shutdown = createGracefulShutdownHandler({ server, markShuttingDown });
      process.on("SIGTERM", () => shutdown("SIGTERM"));
      process.on("SIGINT", () => shutdown("SIGINT"));
    })
    .catch((err: unknown) => {
      logger.error(`[web] Failed to start: ${err}`);
      captureException(err, {
        tags: { serverStartupStep: "main" },
      });
      process.exit(1);
    });
}
