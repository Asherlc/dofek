import http from "node:http";
import { TRPCError } from "@trpc/server";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDbExecute = vi.fn(async () => [{ ok: 1 }]);
const mockQueueWaitUntilReady = vi.fn(async () => undefined);
const mockQueueGetJobCounts = vi.fn(async () => ({ waiting: 0 }));
const mockQueueClose = vi.fn(async () => undefined);
const mockQueue = {
  waitUntilReady: mockQueueWaitUntilReady,
  getJobCounts: mockQueueGetJobCounts,
  close: mockQueueClose,
};
const mockLoggerInfo = vi.fn();
const mockSentryCaptureException = vi.fn();
const mockInitSentry = vi.fn();
const mockGetDefaultMetricStreamEventPublisher = vi.fn();
const mockValidateAccountErasureLedgerKeyring = vi.fn();
const mockReconcileAccountErasureRestoreIntents = vi.fn(async () => ({ recoveredRequestIds: [] }));
const mockAccountErasureRestoreLedger = {
  findIntent: vi.fn(async () => null),
  listIntentReferences: vi.fn(async () => []),
  listIntentsForIdentities: vi.fn(async () => []),
  recordIntent: vi.fn(async () => undefined),
};
const mockCreateAccountErasureRestoreLedgerFromEnv = vi.fn(() => mockAccountErasureRestoreLedger);
const mockCreateExpressMiddleware = vi.fn(
  (_options: {
    createContext: (input: {
      req: { headers: Record<string, string | string[] | undefined> };
    }) => Promise<{ metricStreamPublisher?: unknown }>;
    onError?: (input: { error: TRPCError; path?: string }) => void;
  }) => express.Router(),
);
const mockFitFileImportQueue = { ...mockQueue, name: "fit-file-import" };
const mockFitFileImportBatchQueue = { ...mockQueue, name: "fit-file-import-batch" };
const mockZipEntryExtractQueue = { ...mockQueue, name: "zip-entry-extract" };
const mockCheckReadiness = vi.fn(async () => ({
  status: "ok" as const,
  checks: {
    postgres: "ok" as const,
    clickhouse: "ok" as const,
    queues: "ok" as const,
  },
}));
const mockCreateExternalWriteApiRouter = vi.fn(() => {
  const router = express.Router();
  router.get("/__test_external_mount", (_req, res) => res.sendStatus(204));
  return router;
});
const mockCreateDeveloperClientsRouter = vi.fn(() => {
  const router = express.Router();
  router.get("/__test_developer_mount", (_req, res) => res.sendStatus(204));
  return router;
});

vi.mock("@bull-board/express", () => ({
  ExpressAdapter: vi.fn(() => ({
    setBasePath: vi.fn(),
    getRouter: vi.fn(() => express.Router()),
  })),
}));

vi.mock("@bull-board/api", () => ({
  createBullBoard: vi.fn(),
}));

vi.mock("@trpc/server/adapters/express", () => ({
  createExpressMiddleware: mockCreateExpressMiddleware,
}));

vi.mock("@bull-board/api/bullMQAdapter", () => ({
  BullMQAdapter: vi.fn(() => ({})),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn((path: Parameters<typeof actual.existsSync>[0]) =>
      typeof path === "string" &&
      (path.endsWith("/web/dist") || path.endsWith("/web/dist/index.html"))
        ? true
        : actual.existsSync(path),
    ),
    readFileSync: vi.fn((...args: Parameters<typeof actual.readFileSync>) =>
      typeof args[0] === "string" && args[0].endsWith("/web/dist/index.html")
        ? "<!doctype html><html><body>Dofek</body></html>"
        : actual.readFileSync(...args),
    ),
  };
});

// Return a defined sentinel object so wiring tests can distinguish `{}` (mutant)
// from `{ db: fakeDb }` (real wiring). Without this, `toHaveBeenCalledWith({ db: fakeDb })`
// passes even when `{ db }` is mutated to `{}` because `fakeDb` was `undefined` and
// `{}` deep-equals `{ db: undefined }`.
vi.mock("dofek/db", () => ({ createDatabaseFromEnv: vi.fn(() => ({ execute: mockDbExecute })) }));
vi.mock("dofek/db/clickhouse", () => ({
  bootstrapClickHouseFromEnv: vi.fn(),
  createClickHouseClientFromEnv: vi.fn(),
}));
vi.mock("../../../src/metric-stream/redpanda-producer.ts", () => ({
  getDefaultMetricStreamEventPublisher: mockGetDefaultMetricStreamEventPublisher,
}));
vi.mock("../../../src/account-erasure/identity.ts", () => ({
  validateAccountErasureLedgerKeyring: mockValidateAccountErasureLedgerKeyring,
}));
vi.mock("../../../src/account-erasure/remote-snapshot.ts", () => ({
  createEncryptedAccountErasureSnapshot: vi.fn(),
}));
vi.mock("../../../src/account-erasure/restore-ledger.ts", () => ({
  createAccountErasureRestoreLedgerFromEnv: mockCreateAccountErasureRestoreLedgerFromEnv,
  createLazyAccountErasureRestoreLedger: mockCreateAccountErasureRestoreLedgerFromEnv,
}));
vi.mock("../../../src/account-erasure/restore-reconciliation.ts", () => ({
  reconcileAccountErasureRestoreIntents: mockReconcileAccountErasureRestoreIntents,
}));
vi.mock("dofek/jobs/queues", () => ({
  createActivityDeleteAnalyticsQueue: vi.fn(() => mockQueue),
  createExportQueue: vi.fn(() => mockQueue),
  createFitFileImportBatchQueue: vi.fn(() => mockFitFileImportBatchQueue),
  createFitFileImportQueue: vi.fn(() => mockFitFileImportQueue),
  createImportQueue: vi.fn(() => mockQueue),
  getImportQueue: vi.fn(() => mockQueue),
  createPostSyncQueue: vi.fn(() => mockQueue),
  createScheduledSyncQueue: vi.fn(() => mockQueue),
  createSyncQueue: vi.fn(() => mockQueue),
  createZipEntryExtractQueue: vi.fn(() => mockZipEntryExtractQueue),
}));
vi.mock("../repositories/clickhouse-activity-sensor-store.ts", () => ({
  ClickHouseActivitySensorStore: vi.fn(),
}));
vi.mock("../repositories/limited-activity-sensor-store.ts", () => ({
  LimitedActivitySensorStore: vi.fn(),
}));
vi.mock("./lib/sentry.ts", () => ({
  initSentry: mockInitSentry,
  sentryErrorHandler: vi.fn(
    () => (_error: unknown, _req: unknown, _res: unknown, next: (error?: unknown) => void) =>
      next(),
  ),
}));
vi.mock("@sentry/node", () => ({ captureException: mockSentryCaptureException }));
vi.mock("./logger.ts", () => ({
  logger: { info: mockLoggerInfo, warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../mcp/route.ts", () => ({ createMcpRouter: vi.fn(() => express.Router()) }));
vi.mock("../router.ts", () => ({ appRouter: {} }));
vi.mock("../auth/admin.ts", () => ({
  isAdmin: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));
vi.mock("./auth/cookies.ts", () => ({ getSessionIdFromRequest: vi.fn() }));
vi.mock("./auth/session.ts", () => ({
  validateSession: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));
vi.mock("./billing/access-window-repository.ts", () => ({ getAccessWindowForUser: vi.fn() }));
vi.mock("../lib/metrics.ts", () => ({
  httpRequestDuration: { observe: vi.fn() },
  registry: { registerMetric: vi.fn(), contentType: "text/plain", metrics: vi.fn(async () => "") },
}));
vi.mock("./lib/readiness.ts", () => ({ checkReadiness: mockCheckReadiness }));
vi.mock("../routes/activity-export.ts", () => ({
  createActivityExportRouter: vi.fn(() => express.Router()),
}));
vi.mock("../routes/auth/index.ts", () => ({ createAuthRouter: vi.fn(() => express.Router()) }));
vi.mock("../routes/export.ts", () => ({ createExportRouter: vi.fn(() => express.Router()) }));
vi.mock("./routes/external-write-api.ts", () => ({
  createExternalWriteApiRouter: mockCreateExternalWriteApiRouter,
}));
vi.mock("./routes/developer-clients.ts", () => ({
  createDeveloperClientsRouter: mockCreateDeveloperClientsRouter,
}));
vi.mock("./routes/ingest-zos-health.ts", () => ({
  createIngestZosHealthRouter: vi.fn(() => express.Router()),
}));
vi.mock("./routes/companion-pairing.ts", () => ({
  createCompanionPairingRouter: vi.fn(() => express.Router()),
}));
vi.mock("./routes/companion-token.ts", () => ({
  createCompanionTokenHttpRouter: vi.fn(() => {
    const router = express.Router();
    router.get("/current", (_req, res) => {
      res.status(200).json({ state: "connected" });
    });
    return router;
  }),
}));
vi.mock("../routes/stripe-webhook.ts", () => ({
  createStripeWebhookRouter: vi.fn(() => express.Router()),
}));
vi.mock("../routes/webhooks.ts", () => ({ createWebhookRouter: vi.fn(() => express.Router()) }));

import { getSessionIdFromRequest } from "./auth/cookies.ts";
import { validateSession } from "./auth/session.ts";
import { getAccessWindowForUser } from "./billing/access-window-repository.ts";
import { makeMockSensorStore } from "./routers/test-helpers.ts";

const { createApp, main } = await import("./index.ts");

function request(
  app: express.Express,
  method: string,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("unexpected address"));
        return;
      }
      const req = http.request({ hostname: "127.0.0.1", port: addr.port, path, method }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          server.close();
          resolve({ status: res.statusCode ?? 0, body });
        });
      });
      req.on("error", (err) => {
        server.close();
        reject(err);
      });
      req.end();
    });
  });
}

describe("createApp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbExecute.mockResolvedValue([{ ok: 1 }]);
    mockQueueWaitUntilReady.mockResolvedValue(undefined);
    mockQueueGetJobCounts.mockResolvedValue({ waiting: 0 });
    mockQueueClose.mockResolvedValue(undefined);
    mockCheckReadiness.mockResolvedValue({
      status: "ok",
      checks: {
        postgres: "ok",
        clickhouse: "ok",
        queues: "ok",
      },
    });
    mockLoggerInfo.mockReset();
    mockSentryCaptureException.mockReset();
  });

  it("returns 404 for non-existent routes", async () => {
    const { createDatabaseFromEnv } = await import("dofek/db");
    const fakeDb = createDatabaseFromEnv();
    const app = createApp(fakeDb, makeMockSensorStore());
    const res = await request(app, "GET", "/api/nonexistent");
    expect(res.status).toBe(404);
  });

  it("redacts sensitive query parameters in request logs", async () => {
    const { createDatabaseFromEnv } = await import("dofek/db");
    const app = createApp(createDatabaseFromEnv(), makeMockSensorStore());

    const res = await request(app, "GET", "/api/nonexistent?session=secret-session&foo=visible");
    const codeRes = await request(app, "GET", "/api/nonexistent?code=secret-code&foo=visible");

    expect(res.status).toBe(404);
    expect(codeRes.status).toBe(404);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/nonexistent\?session=%5B[A-Z]+%5D&foo=visible/),
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/nonexistent\?code=%5B[A-Z]+%5D&foo=visible/),
    );
    expect(mockLoggerInfo.mock.calls[0]?.[0]).not.toContain("code=");
    expect(mockLoggerInfo.mock.calls[1]?.[0]).not.toContain("session=");
    expect(mockLoggerInfo).not.toHaveBeenCalledWith(expect.stringContaining("secret-session"));
    expect(mockLoggerInfo).not.toHaveBeenCalledWith(expect.stringContaining("secret-code"));
  });

  it("reports malformed request URLs and continues logging", async () => {
    const { createDatabaseFromEnv } = await import("dofek/db");
    const app = createApp(createDatabaseFromEnv(), makeMockSensorStore());

    vi.stubGlobal(
      "URL",
      vi.fn(() => {
        throw new TypeError("malformed request URL");
      }),
    );
    try {
      const res = await request(app, "GET", "/api/nonexistent");

      expect(res.status).toBe(404);
      expect(mockSentryCaptureException).toHaveBeenCalledWith(expect.any(TypeError), {
        tags: { context: "request-url-logging" },
      });
      expect(mockLoggerInfo).toHaveBeenCalledWith(expect.stringContaining("/api/nonexistent"));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not serve the SPA shell for missing JavaScript assets", async () => {
    const { createDatabaseFromEnv } = await import("dofek/db");
    const fakeDb = createDatabaseFromEnv();
    const app = createApp(fakeDb, makeMockSensorStore());

    const res = await request(app, "GET", "/assets/strength.lazy-missing.js");

    expect(res.status).toBe(404);
    expect(res.body).not.toContain("<!doctype html>");
  });

  it("serves the SPA shell for client-side routes", async () => {
    const { createDatabaseFromEnv } = await import("dofek/db");
    const fakeDb = createDatabaseFromEnv();
    const app = createApp(fakeDb, makeMockSensorStore());

    const res = await request(app, "GET", "/strength");

    expect(res.status).toBe(200);
    expect(res.body).toContain("<!doctype html>");
  });

  it.each([
    "/robots.txt",
    "/llms.txt",
    "/missing/image.png",
  ])("returns 404 instead of the SPA shell for missing file-like path %s", async (path) => {
    const { createDatabaseFromEnv } = await import("dofek/db");
    const fakeDb = createDatabaseFromEnv();
    const app = createApp(fakeDb, makeMockSensorStore());

    const res = await request(app, "GET", path);

    expect(res.status).toBe(404);
    expect(res.body).not.toContain("<!doctype html>");
  });

  it("registers the ingest route using createIngestZosHealthRouter", async () => {
    const { createIngestZosHealthRouter } = await import("./routes/ingest-zos-health.ts");
    const { createDatabaseFromEnv } = await import("dofek/db");
    const fakeDb = createDatabaseFromEnv();
    createApp(fakeDb, makeMockSensorStore());
    expect(createIngestZosHealthRouter).toHaveBeenCalled();
  });

  it("registers FIT import flow queues in Bull Board", async () => {
    const { BullMQAdapter } = await import("@bull-board/api/bullMQAdapter");
    const { createDatabaseFromEnv } = await import("dofek/db");
    vi.mocked(BullMQAdapter).mockClear();

    createApp(createDatabaseFromEnv(), makeMockSensorStore());

    expect(BullMQAdapter).toHaveBeenCalledWith(mockFitFileImportQueue);
    expect(BullMQAdapter).toHaveBeenCalledWith(mockFitFileImportBatchQueue);
    expect(BullMQAdapter).toHaveBeenCalledWith(mockZipEntryExtractQueue);
  });

  it("passes db to createIngestZosHealthRouter", async () => {
    const { createIngestZosHealthRouter } = await import("./routes/ingest-zos-health.ts");
    const { createDatabaseFromEnv } = await import("dofek/db");
    const fakeDb = createDatabaseFromEnv();
    createApp(fakeDb, makeMockSensorStore());
    expect(createIngestZosHealthRouter).toHaveBeenCalledWith({ db: fakeDb });
  });

  it("passes db to companion route modules", async () => {
    const { createCompanionPairingRouter } = await import("./routes/companion-pairing.ts");
    const { createCompanionTokenHttpRouter } = await import("./routes/companion-token.ts");
    const { createDatabaseFromEnv } = await import("dofek/db");
    const fakeDb = createDatabaseFromEnv();

    createApp(fakeDb, makeMockSensorStore());

    expect(createCompanionPairingRouter).toHaveBeenCalledWith({ db: fakeDb });
    expect(createCompanionTokenHttpRouter).toHaveBeenCalledWith({ db: fakeDb });
  });

  it("mounts the developer-client router with its required repository", async () => {
    const { createDatabaseFromEnv } = await import("dofek/db");
    const { DeveloperClientRepository } = await import(
      "./repositories/developer-client-repository.ts"
    );
    const fakeDb = createDatabaseFromEnv();
    const app = createApp(fakeDb, makeMockSensorStore());

    expect(mockCreateDeveloperClientsRouter).toHaveBeenCalledWith({
      db: fakeDb,
      repository: expect.any(DeveloperClientRepository),
    });
    expect(
      (await request(app, "GET", "/api/developer/clients/__test_developer_mount")).status,
    ).toBe(204);
  });

  it("does not apply the password-login rate limit to companion status checks", async () => {
    const { createDatabaseFromEnv } = await import("dofek/db");
    const app = createApp(createDatabaseFromEnv(), makeMockSensorStore());

    const responses = await Promise.all(
      Array.from({ length: 31 }, () => request(app, "GET", "/api/companion-token/current")),
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);
  });

  it("reports the original cause of unexpected tRPC failures", async () => {
    const { createDatabaseFromEnv } = await import("dofek/db");
    createApp(createDatabaseFromEnv(), makeMockSensorStore());
    const middlewareOptions = mockCreateExpressMiddleware.mock.calls.at(-1)?.[0];
    const databaseError = new Error(
      "Failed query: SELECT user_id FROM fitness.session WHERE id = $1",
    );

    middlewareOptions?.onError?.({
      error: new TRPCError({ code: "INTERNAL_SERVER_ERROR", cause: databaseError }),
      path: "weeklyReport.get",
    });

    expect(mockSentryCaptureException).toHaveBeenCalledWith(databaseError, {
      tags: { trpcPath: "weeklyReport.get" },
    });
  });

  it("returns ready when Postgres, ClickHouse, and queues are reachable", async () => {
    const { createDatabaseFromEnv } = await import("dofek/db");
    const fakeDb = createDatabaseFromEnv();
    const sensorStore = makeMockSensorStore([{ ok: 1 }]);
    const app = createApp(fakeDb, sensorStore);

    const res = await request(app, "GET", "/readyz");

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      status: "ok",
      checks: {
        postgres: "ok",
        clickhouse: "ok",
        queues: "ok",
      },
    });
    expect(mockCheckReadiness).toHaveBeenCalledWith({
      db: fakeDb,
      sensorStore,
    });
  });

  it("returns unavailable when a readiness dependency fails", async () => {
    mockCheckReadiness.mockResolvedValueOnce({
      status: "error",
      checks: {
        postgres: "error",
        clickhouse: "ok",
        queues: "ok",
      },
    });
    const { createDatabaseFromEnv } = await import("dofek/db");
    const fakeDb = createDatabaseFromEnv();
    const app = createApp(fakeDb, makeMockSensorStore([{ ok: 1 }]));

    const res = await request(app, "GET", "/readyz");

    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toEqual({
      status: "error",
      checks: {
        postgres: "error",
        clickhouse: "ok",
        queues: "ok",
      },
    });
  });
});

describe("main", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDefaultMetricStreamEventPublisher.mockReset();
    mockReconcileAccountErasureRestoreIntents.mockResolvedValue({
      recoveredRequestIds: [],
    });
  });

  it("does not initialize traffic dependencies when restore reconciliation fails", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://health:health@db:5432/health");
    vi.stubEnv("CLICKHOUSE_URL", "http://default:health@clickhouse:8123");
    const restoreError = new Error("restore intent reconciliation failed");
    mockReconcileAccountErasureRestoreIntents.mockRejectedValueOnce(restoreError);
    const listen = vi.spyOn(express.application, "listen");

    try {
      await expect(main()).rejects.toThrow(restoreError);
      expect(mockInitSentry).toHaveBeenCalled();
      expect(mockGetDefaultMetricStreamEventPublisher).not.toHaveBeenCalled();
      expect(listen).not.toHaveBeenCalled();
    } finally {
      listen.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("does not listen when the metric-stream producer cannot connect", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://health:health@db:5432/health");
    vi.stubEnv("CLICKHOUSE_URL", "http://default:health@clickhouse:8123");
    const brokerError = new Error("connect ECONNREFUSED redpanda:9092");
    mockGetDefaultMetricStreamEventPublisher.mockRejectedValue(brokerError);
    const listen = vi.spyOn(express.application, "listen");

    try {
      await expect(main()).rejects.toThrow(brokerError);
      expect(listen).not.toHaveBeenCalled();
    } finally {
      listen.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("passes the connected metric-stream publisher to request context", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://health:health@db:5432/health");
    vi.stubEnv("CLICKHOUSE_URL", "http://default:health@clickhouse:8123");
    const metricStreamPublisher = { publishRows: vi.fn() };
    mockGetDefaultMetricStreamEventPublisher.mockResolvedValue(metricStreamPublisher);
    const listen = vi.spyOn(express.application, "listen").mockReturnValue(new http.Server());

    try {
      await main();
      const middlewareOptions = mockCreateExpressMiddleware.mock.calls.at(-1)?.[0];
      expect(middlewareOptions).toBeDefined();
      const context = await middlewareOptions?.createContext({ req: { headers: {} } });
      expect(context?.metricStreamPublisher).toBe(metricStreamPublisher);
    } finally {
      listen.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("passes the request timezone to access-window resolution", async () => {
    const { createDatabaseFromEnv } = await import("dofek/db");
    const fakeDb = createDatabaseFromEnv();
    vi.mocked(getSessionIdFromRequest).mockReturnValue("session-id");
    vi.mocked(validateSession).mockResolvedValue({
      sessionId: "session-id",
      userId: "user-1",
      expiresAt: new Date("2026-07-28T00:00:00.000Z"),
    });
    createApp(fakeDb, makeMockSensorStore());
    const middlewareOptions = mockCreateExpressMiddleware.mock.calls.at(-1)?.[0];

    await middlewareOptions?.createContext({
      req: { headers: { "x-timezone": "America/Los_Angeles" } },
    });

    expect(getAccessWindowForUser).toHaveBeenCalledWith(fakeDb, "user-1", "America/Los_Angeles");
  });

  it("uses UTC for access-window resolution when the timezone header is absent", async () => {
    const { createDatabaseFromEnv } = await import("dofek/db");
    const fakeDb = createDatabaseFromEnv();
    vi.mocked(getSessionIdFromRequest).mockReturnValue("session-id");
    vi.mocked(validateSession).mockResolvedValue({
      sessionId: "session-id",
      userId: "user-1",
      expiresAt: new Date("2026-07-28T00:00:00.000Z"),
    });
    createApp(fakeDb, makeMockSensorStore());
    const middlewareOptions = mockCreateExpressMiddleware.mock.calls.at(-1)?.[0];

    await middlewareOptions?.createContext({ req: { headers: {} } });

    expect(getAccessWindowForUser).toHaveBeenCalledWith(fakeDb, "user-1", "UTC");
  });

  it("rejects an invalid request timezone before access-window resolution", async () => {
    const { createDatabaseFromEnv } = await import("dofek/db");
    const fakeDb = createDatabaseFromEnv();
    vi.mocked(getSessionIdFromRequest).mockReturnValue("session-id");
    vi.mocked(validateSession).mockResolvedValue({
      sessionId: "session-id",
      userId: "user-1",
      expiresAt: new Date("2026-07-28T00:00:00.000Z"),
    });
    createApp(fakeDb, makeMockSensorStore());
    const middlewareOptions = mockCreateExpressMiddleware.mock.calls.at(-1)?.[0];

    await expect(
      middlewareOptions?.createContext({
        req: { headers: { "x-timezone": "Not/A_Timezone" } },
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Invalid x-timezone header",
    });
    expect(getAccessWindowForUser).not.toHaveBeenCalled();
  });

  it("mounts the external write API router with the application database", async () => {
    const { createDatabaseFromEnv } = await import("dofek/db");
    const fakeDb = createDatabaseFromEnv();

    createApp(fakeDb, makeMockSensorStore());

    expect(mockCreateExternalWriteApiRouter).toHaveBeenCalledWith({ db: fakeDb });

    const app = createApp(fakeDb, makeMockSensorStore());
    const router = Reflect.get(app, "router");
    const routerStack =
      router &&
      (typeof router === "object" || typeof router === "function") &&
      "stack" in router &&
      Array.isArray(router.stack)
        ? router.stack
        : [];
    const externalRouter = mockCreateExternalWriteApiRouter.mock.results.at(-1)?.value;
    expect(
      routerStack.some(
        (layer) =>
          layer &&
          typeof layer === "object" &&
          "handle" in layer &&
          layer.handle === externalRouter,
      ),
    ).toBe(true);
  });
});
