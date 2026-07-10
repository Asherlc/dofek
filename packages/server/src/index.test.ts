import http from "node:http";
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
const mockCheckReadiness = vi.fn(async () => ({
  status: "ok" as const,
  checks: {
    postgres: "ok" as const,
    clickhouse: "ok" as const,
    queues: "ok" as const,
  },
}));

vi.mock("@bull-board/express", () => ({
  ExpressAdapter: vi.fn(() => ({
    setBasePath: vi.fn(),
    getRouter: vi.fn(() => express.Router()),
  })),
}));

vi.mock("@bull-board/api", () => ({
  createBullBoard: vi.fn(),
}));

vi.mock("@bull-board/api/bullMQAdapter", () => ({
  BullMQAdapter: vi.fn(() => ({})),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(
      (path: string) => path.endsWith("/web/dist") || path.endsWith("/web/dist/index.html"),
    ),
    readFileSync: vi.fn(() => "<!doctype html><html><body>Dofek</body></html>"),
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
vi.mock("dofek/jobs/queues", () => ({
  createActivityDeleteAnalyticsQueue: vi.fn(() => mockQueue),
  createExportQueue: vi.fn(() => mockQueue),
  createImportQueue: vi.fn(() => mockQueue),
  getImportQueue: vi.fn(() => mockQueue),
  createPostSyncQueue: vi.fn(() => mockQueue),
  createScheduledSyncQueue: vi.fn(() => mockQueue),
  createSyncQueue: vi.fn(() => mockQueue),
}));
vi.mock("../repositories/clickhouse-activity-sensor-store.ts", () => ({
  ClickHouseActivitySensorStore: vi.fn(),
}));
vi.mock("../repositories/limited-activity-sensor-store.ts", () => ({
  LimitedActivitySensorStore: vi.fn(),
}));
vi.mock("../lib/sentry.ts", () => ({
  initSentry: vi.fn(),
  sentryErrorHandler: vi.fn(
    () => (_error: unknown, _req: unknown, _res: unknown, next: (error?: unknown) => void) =>
      next(),
  ),
}));
vi.mock("../mcp/route.ts", () => ({ createMcpRouter: vi.fn(() => express.Router()) }));
vi.mock("../router.ts", () => ({ appRouter: {} }));
vi.mock("../auth/admin.ts", () => ({
  isAdmin: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));
vi.mock("../auth/cookies.ts", () => ({ getSessionIdFromRequest: vi.fn() }));
vi.mock("../auth/session.ts", () => ({
  validateSession: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));
vi.mock("../billing/access-window-repository.ts", () => ({ getAccessWindowForUser: vi.fn() }));
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
vi.mock("./routes/ingest-zos-health.ts", () => ({
  createIngestZosHealthRouter: vi.fn(() => express.Router()),
}));
vi.mock("../routes/stripe-webhook.ts", () => ({
  createStripeWebhookRouter: vi.fn(() => express.Router()),
}));
vi.mock("../routes/upload.ts", () => ({ createUploadRouter: vi.fn(() => express.Router()) }));
vi.mock("../routes/webhooks.ts", () => ({ createWebhookRouter: vi.fn(() => express.Router()) }));
vi.mock("../slack/bot.ts", () => ({ startSlackBot: vi.fn() }));

import { makeMockSensorStore } from "./routers/test-helpers.ts";

const { createApp } = await import("./index.ts");

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
  });

  it("returns 404 for non-existent routes", async () => {
    const { createDatabaseFromEnv } = await import("dofek/db");
    const fakeDb = createDatabaseFromEnv();
    const app = createApp(fakeDb, makeMockSensorStore());
    const res = await request(app, "GET", "/api/nonexistent");
    expect(res.status).toBe(404);
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

  it("registers the ingest route using createIngestZosHealthRouter", async () => {
    const { createIngestZosHealthRouter } = await import("./routes/ingest-zos-health.ts");
    const { createDatabaseFromEnv } = await import("dofek/db");
    const fakeDb = createDatabaseFromEnv();
    createApp(fakeDb, makeMockSensorStore());
    expect(createIngestZosHealthRouter).toHaveBeenCalled();
  });

  it("passes db to createIngestZosHealthRouter", async () => {
    const { createIngestZosHealthRouter } = await import("./routes/ingest-zos-health.ts");
    const { createDatabaseFromEnv } = await import("dofek/db");
    const fakeDb = createDatabaseFromEnv();
    createApp(fakeDb, makeMockSensorStore());
    expect(createIngestZosHealthRouter).toHaveBeenCalledWith({ db: fakeDb });
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
