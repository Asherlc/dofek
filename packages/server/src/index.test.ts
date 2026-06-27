import http from "node:http";
import express from "express";
import { describe, expect, it, vi } from "vitest";

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

vi.mock("dofek/db", () => ({ createDatabaseFromEnv: vi.fn() }));
vi.mock("dofek/db/clickhouse", () => ({
  bootstrapClickHouseFromEnv: vi.fn(),
  createClickHouseClientFromEnv: vi.fn(),
}));
vi.mock("dofek/jobs/queues", () => ({
  createActivityDeleteAnalyticsQueue: vi.fn(),
  createExportQueue: vi.fn(),
  createImportQueue: vi.fn(),
  createPostSyncQueue: vi.fn(),
  createScheduledSyncQueue: vi.fn(),
  createSyncQueue: vi.fn(),
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
  httpRequestDuration: { labels: vi.fn(() => ({ observe: vi.fn() })) },
  registry: { registerMetric: vi.fn(), contentType: "text/plain", metrics: vi.fn(async () => "") },
}));
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
  it("returns 404 for non-existent routes", async () => {
    const { createDatabaseFromEnv } = await import("dofek/db");
    const fakeDb = createDatabaseFromEnv();
    const app = createApp(fakeDb, makeMockSensorStore());
    const res = await request(app, "GET", "/api/nonexistent");
    expect(res.status).toBe(404);
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
});
