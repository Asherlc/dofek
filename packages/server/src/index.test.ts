import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  init: vi.fn(),
}));
vi.mock("@bull-board/api", () => ({
  createBullBoard: vi.fn(),
}));
vi.mock("@bull-board/api/bullMQAdapter", () => ({
  BullMQAdapter: vi.fn((queue: unknown) => ({ queue })),
}));
vi.mock("@bull-board/express", () => ({
  ExpressAdapter: vi.fn(() => ({
    setBasePath: vi.fn(),
    getRouter: vi.fn(
      () =>
        (_req: unknown, res: { status: (code: number) => { send: (body: string) => void } }) => {
          res.status(200).send("bull-board");
        },
    ),
  })),
}));
vi.mock("@trpc/server/adapters/express", () => ({
  createExpressMiddleware: vi.fn(
    () => (_req: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }) => {
      res.status(404).json({ error: "not found" });
    },
  ),
}));
vi.mock("dofek/jobs/queues", () => ({
  createImportQueue: vi.fn(() => ({ _queue: "import" })),
  createSyncQueue: vi.fn(() => ({ _queue: "sync" })),
  createExportQueue: vi.fn(() => ({ _queue: "export" })),
  createScheduledSyncQueue: vi.fn(() => ({ _queue: "scheduled-sync" })),
  createPostSyncQueue: vi.fn(() => ({ _queue: "post-sync" })),
  createTrainingExportQueue: vi.fn(() => ({ _queue: "training-export" })),
}));
vi.mock("./auth/admin.ts", () => ({
  isAdmin: vi.fn().mockResolvedValue(false),
}));
vi.mock("./auth/cookies.ts", () => ({
  getSessionIdFromRequest: vi.fn(),
  setSessionCookie: vi.fn(),
}));
vi.mock("./auth/session.ts", () => ({
  validateSession: vi.fn(),
}));
vi.mock("./lib/metrics.ts", () => ({
  httpRequestDuration: { observe: vi.fn() },
  registry: { contentType: "text/plain", metrics: vi.fn(() => Promise.resolve("")) },
}));
vi.mock("./lib/warm-cache.ts", () => ({
  warmCache: vi.fn(() => Promise.resolve()),
}));
vi.mock("./logger.ts", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));
vi.mock("./router.ts", () => ({
  appRouter: {},
}));
vi.mock("./routes/auth/index.ts", () => ({
  createAuthRouter: vi.fn(() => {
    const { Router } = require("express");
    return Router();
  }),
}));
vi.mock("./routes/export.ts", () => ({
  createExportRouter: vi.fn(() => {
    const { Router } = require("express");
    return Router();
  }),
}));
vi.mock("./routes/materialized-view-refresh.ts", () => ({
  createMaterializedViewRefreshRouter: vi.fn(() => {
    const { Router } = require("express");
    return Router();
  }),
}));
vi.mock("./routes/upload.ts", () => ({
  createUploadRouter: vi.fn(() => {
    const { Router } = require("express");
    return Router();
  }),
}));
vi.mock("./routes/webhooks.ts", () => ({
  createWebhookRouter: vi.fn(() => {
    const { Router } = require("express");
    return Router();
  }),
}));
vi.mock("./slack/bot.ts", () => ({
  startSlackBot: vi.fn(() => Promise.resolve()),
}));

vi.mock("dofek/db", () => ({
  createDatabaseFromEnv: vi.fn(() => ({
    execute: vi.fn().mockResolvedValue([]),
  })),
}));

import * as Sentry from "@sentry/node";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { createDatabaseFromEnv } from "dofek/db";
import express from "express";
import { isAdmin } from "./auth/admin.ts";
import { getSessionIdFromRequest } from "./auth/cookies.ts";
import { validateSession } from "./auth/session.ts";
import { createApp, main, runStartupTasks } from "./index.ts";
import { httpRequestDuration, registry } from "./lib/metrics.ts";
import { warmCache } from "./lib/warm-cache.ts";
import { logger } from "./logger.ts";
import { createAuthRouter } from "./routes/auth/index.ts";
import { createMaterializedViewRefreshRouter } from "./routes/materialized-view-refresh.ts";
import { createUploadRouter } from "./routes/upload.ts";
import { createWebhookRouter } from "./routes/webhooks.ts";
import { startSlackBot } from "./slack/bot.ts";

function startApp(
  app: ReturnType<typeof createApp>,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("Expected AddressInfo");
      const baseUrl = `http://localhost:${addr.port}`;
      resolve({
        baseUrl,
        close: () =>
          new Promise<void>((res) => {
            server.closeAllConnections?.();
            server.close(() => res());
          }),
      });
    });
  });
}

describe("createApp", () => {
  it("creates an Express app with routes", () => {
    const fakeDb = createDatabaseFromEnv();
    const app = createApp(fakeDb);
    expect(app).toBeDefined();
    expect(typeof app.listen).toBe("function");
  });
});

describe("createApp HTTP routes", () => {
  let baseUrl: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(getSessionIdFromRequest).mockReturnValue(undefined);
    vi.mocked(validateSession).mockResolvedValue(null);
    vi.mocked(isAdmin).mockResolvedValue(false);
    vi.mocked(registry.metrics).mockResolvedValue("# HELP\n# TYPE\n");

    const fakeDb = createDatabaseFromEnv();
    const app = createApp(fakeDb);
    ({ baseUrl, close } = await startApp(app));
  });

  afterEach(async () => {
    await close();
  });

  describe("GET /healthz", () => {
    it("returns 200 with status ok", async () => {
      const res = await fetch(`${baseUrl}/healthz`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ status: "ok" });
    });
  });

  describe("GET /metrics", () => {
    it("returns 200 with metrics content type", async () => {
      const res = await fetch(`${baseUrl}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/plain");
    });

    it("returns the registry metrics body", async () => {
      const { registry } = await import("./lib/metrics.ts");
      vi.mocked(registry.metrics).mockResolvedValue(
        "# HELP test_metric A test\n# TYPE test_metric gauge\n",
      );
      const res = await fetch(`${baseUrl}/metrics`);
      const body = await res.text();
      expect(body).toContain("test_metric");
    });
  });

  describe("GET /api/metrics", () => {
    it("mirrors /metrics and returns 200", async () => {
      const res = await fetch(`${baseUrl}/api/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/plain");
    });
  });

  describe("request duration middleware", () => {
    it("logs request method, path, and status code on response finish", async () => {
      vi.mocked(logger.info).mockClear();
      // Use /api/trpc which goes through the logging middleware
      await fetch(`${baseUrl}/api/trpc/nonexistent`);
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        expect.stringMatching(/\[web\].*GET.*\/api\/trpc\/nonexistent.*\d+ms/),
      );
    });

    it("observes request duration in histogram", async () => {
      vi.mocked(httpRequestDuration.observe).mockClear();
      await fetch(`${baseUrl}/api/trpc/nonexistent`);
      expect(httpRequestDuration.observe).toHaveBeenCalledWith(
        expect.objectContaining({ method: "GET", status_code: expect.any(Number) }),
        expect.any(Number),
      );
    });

    it("records duration in seconds (divided by 1000)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const baseTime = new Date("2026-01-01T00:00:00.000Z");
      vi.setSystemTime(baseTime);

      // Override tRPC mock so the handler advances fake clock before responding,
      // giving the logging middleware a non-zero duration between start and finish.
      const handler: import("express").RequestHandler = (_req, res) => {
        vi.setSystemTime(new Date(baseTime.getTime() + 42));
        res.status(404).json({ error: "not found" });
      };
      vi.mocked(createExpressMiddleware).mockReturnValueOnce(handler);

      const fakeDb = createDatabaseFromEnv();
      const app = createApp(fakeDb);
      const { baseUrl: testUrl, close: testClose } = await startApp(app);
      try {
        vi.mocked(httpRequestDuration.observe).mockClear();
        await fetch(`${testUrl}/api/trpc/nonexistent`);
        const durationSeconds = vi.mocked(httpRequestDuration.observe).mock.calls[0][1];
        // 42ms / 1000 = 0.042 seconds
        expect(durationSeconds).toBeCloseTo(0.042, 3);
      } finally {
        await testClose();
        vi.useRealTimers();
      }
    });

    it("strips query params from the route label", async () => {
      vi.mocked(httpRequestDuration.observe).mockClear();
      await fetch(`${baseUrl}/api/trpc/nonexistent?batch=1&input=foo`);
      const labels = vi.mocked(httpRequestDuration.observe).mock.calls[0]?.[0];
      expect(labels?.route).not.toContain("?");
      expect(labels?.route).toContain("/api/trpc/nonexistent");
    });
  });

  describe("GET /admin/queues — admin middleware", () => {
    it("returns 401 when no session cookie is present", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue(undefined);
      const res = await fetch(`${baseUrl}/admin/queues`);
      expect(res.status).toBe(401);
      const body = await res.text();
      expect(body).toBe("Authentication required");
    });

    it("returns 401 when session is invalid or expired", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue("some-session-id");
      vi.mocked(validateSession).mockResolvedValue(null);
      const res = await fetch(`${baseUrl}/admin/queues`);
      expect(res.status).toBe(401);
      const body = await res.text();
      expect(body).toBe("Session expired");
    });

    it("returns 403 when authenticated but not admin", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue("valid-session-id");
      vi.mocked(validateSession).mockResolvedValue({
        userId: "user-1",
        expiresAt: new Date("2027-01-01"),
      });
      vi.mocked(isAdmin).mockResolvedValue(false);
      const res = await fetch(`${baseUrl}/admin/queues`);
      expect(res.status).toBe(403);
      const body = await res.text();
      expect(body).toBe("Admin access required");
    });

    it("calls isAdmin with the correct userId from the validated session", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue("valid-session-id");
      vi.mocked(validateSession).mockResolvedValue({
        userId: "user-42",
        expiresAt: new Date("2027-01-01"),
      });
      vi.mocked(isAdmin).mockResolvedValue(false);
      await fetch(`${baseUrl}/admin/queues`);
      expect(vi.mocked(isAdmin)).toHaveBeenCalledWith(expect.anything(), "user-42");
    });

    it("does not call isAdmin when session is missing", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue(undefined);
      await fetch(`${baseUrl}/admin/queues`);
      expect(vi.mocked(isAdmin)).not.toHaveBeenCalled();
    });

    it("does not call isAdmin when session is invalid", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue("bad-session");
      vi.mocked(validateSession).mockResolvedValue(null);
      await fetch(`${baseUrl}/admin/queues`);
      expect(vi.mocked(isAdmin)).not.toHaveBeenCalled();
    });

    it("delegates to Bull Board router when admin is authenticated", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue("admin-session");
      vi.mocked(validateSession).mockResolvedValue({
        userId: "admin-1",
        expiresAt: new Date("2027-01-01"),
      });
      vi.mocked(isAdmin).mockResolvedValue(true);
      const res = await fetch(`${baseUrl}/admin/queues`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toBe("bull-board");
    });

    it("registers all 6 queue types with Bull Board during app creation", async () => {
      const { createBullBoard: mockCreateBullBoard } = await import("@bull-board/api");
      const { BullMQAdapter: MockBullMQAdapter } = await import("@bull-board/api/bullMQAdapter");

      // Bull Board is initialized eagerly during createApp, so check the calls
      // from the beforeEach setup
      expect(vi.mocked(MockBullMQAdapter)).toHaveBeenCalledTimes(6);
      expect(vi.mocked(mockCreateBullBoard)).toHaveBeenCalledWith(
        expect.objectContaining({
          queues: expect.arrayContaining([
            expect.anything(),
            expect.anything(),
            expect.anything(),
            expect.anything(),
            expect.anything(),
            expect.anything(),
          ]),
        }),
      );
      const call = vi.mocked(mockCreateBullBoard).mock.calls[0][0];
      expect(call.queues).toHaveLength(6);
    });

    it("passes queue factory results to BullMQAdapter", async () => {
      const { BullMQAdapter: MockBullMQAdapter } = await import("@bull-board/api/bullMQAdapter");

      const adapterArgs = vi.mocked(MockBullMQAdapter).mock.calls.map((call) => call[0]);
      expect(adapterArgs).toContainEqual({ _queue: "sync" });
      expect(adapterArgs).toContainEqual({ _queue: "import" });
      expect(adapterArgs).toContainEqual({ _queue: "export" });
      expect(adapterArgs).toContainEqual({ _queue: "scheduled-sync" });
      expect(adapterArgs).toContainEqual({ _queue: "post-sync" });
      expect(adapterArgs).toContainEqual({ _queue: "training-export" });
    });
  });

  describe("GET /auth/dev-login", () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalEnableDevLogin = process.env.ENABLE_DEV_LOGIN;

    afterEach(() => {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }

      if (originalEnableDevLogin === undefined) {
        delete process.env.ENABLE_DEV_LOGIN;
      } else {
        process.env.ENABLE_DEV_LOGIN = originalEnableDevLogin;
      }
    });

    it("returns 404 when no dev-session exists", async () => {
      const res = await fetch(`${baseUrl}/auth/dev-login`, { redirect: "manual" });
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).toContain("No dev-session found");
    });

    it("returns 404 in production when preview login is not explicitly enabled", async () => {
      process.env.NODE_ENV = "production";
      delete process.env.ENABLE_DEV_LOGIN;

      const fakeDb = createDatabaseFromEnv();
      const app = createApp(fakeDb);
      const { baseUrl: devUrl, close: devClose } = await startApp(app);
      try {
        const res = await fetch(`${devUrl}/auth/dev-login`, { redirect: "manual" });
        expect(res.status).toBe(404);
      } finally {
        await devClose();
      }
    });

    it("sets session cookie and redirects when dev-session exists", async () => {
      const fakeDb = createDatabaseFromEnv();
      const expiresAt = new Date("2027-01-01");
      vi.mocked(fakeDb.execute).mockResolvedValueOnce([
        { id: "dev-session", expires_at: expiresAt },
      ]);

      const app = createApp(fakeDb);
      const { baseUrl: devUrl, close: devClose } = await startApp(app);
      try {
        const res = await fetch(`${devUrl}/auth/dev-login`, { redirect: "manual" });
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe("/dashboard");
        const { setSessionCookie } = await import("./auth/cookies.ts");
        expect(vi.mocked(setSessionCookie)).toHaveBeenCalledWith(
          expect.anything(),
          "dev-session",
          expiresAt,
        );
      } finally {
        await devClose();
      }
    });

    it("allows preview login in production when ENABLE_DEV_LOGIN=true", async () => {
      process.env.NODE_ENV = "production";
      process.env.ENABLE_DEV_LOGIN = "true";

      const fakeDb = createDatabaseFromEnv();
      const expiresAt = new Date("2027-01-01");
      vi.mocked(fakeDb.execute).mockResolvedValueOnce([
        { id: "dev-session", expires_at: expiresAt },
      ]);

      const app = createApp(fakeDb);
      const { baseUrl: devUrl, close: devClose } = await startApp(app);
      try {
        const res = await fetch(`${devUrl}/auth/dev-login`, { redirect: "manual" });
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe("/dashboard");
        const { setSessionCookie } = await import("./auth/cookies.ts");
        expect(vi.mocked(setSessionCookie)).toHaveBeenCalledWith(
          expect.anything(),
          "dev-session",
          expiresAt,
        );
      } finally {
        await devClose();
      }
    });
  });

  describe("tRPC middleware mounting", () => {
    it("handles requests to /api/trpc (middleware is mounted)", async () => {
      const res = await fetch(`${baseUrl}/api/trpc/nonexistent`);
      expect([200, 400, 404, 500]).toContain(res.status);
    });

    it("includes app and assets version headers in tRPC context", async () => {
      const [middlewareOptions] = vi.mocked(createExpressMiddleware).mock.calls.at(-1) ?? [];
      if (!middlewareOptions) {
        throw new Error("Expected createExpressMiddleware to be called");
      }

      const context = await middlewareOptions.createContext({
        req: {
          headers: {
            "x-timezone": "America/Los_Angeles",
            "x-app-version": "2.3.4",
            "x-assets-version": "update-abc123",
          },
        },
        res: {},
      });

      expect(context.timezone).toBe("America/Los_Angeles");
      expect(context.appVersion).toBe("2.3.4");
      expect(context.assetsVersion).toBe("update-abc123");
    });

    it("enables allowMethodOverride", () => {
      const [middlewareOptions] = vi.mocked(createExpressMiddleware).mock.calls.at(-1) ?? [];
      expect(middlewareOptions).toHaveProperty("allowMethodOverride", true);
    });

    it("defaults timezone to UTC when header is missing", async () => {
      const [middlewareOptions] = vi.mocked(createExpressMiddleware).mock.calls.at(-1) ?? [];
      if (!middlewareOptions) throw new Error("Expected createExpressMiddleware to be called");

      const context = await middlewareOptions.createContext({
        req: { headers: {} },
        res: {},
      });

      expect(context.timezone).toBe("UTC");
      expect(context.appVersion).toBeUndefined();
      expect(context.assetsVersion).toBeUndefined();
    });

    it("resolves userId from session when cookie is present", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue("sess-123");
      vi.mocked(validateSession).mockResolvedValue({
        userId: "user-99",
        expiresAt: new Date("2027-01-01"),
      });

      const fakeDb = createDatabaseFromEnv();
      createApp(fakeDb);
      const [middlewareOptions] = vi.mocked(createExpressMiddleware).mock.calls.at(-1) ?? [];
      if (!middlewareOptions) throw new Error("Expected createExpressMiddleware to be called");

      const context = await middlewareOptions.createContext({
        req: { headers: {} },
        res: {},
      });

      expect(context.userId).toBe("user-99");
    });

    it("sets userId to null when no session cookie", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue(undefined);

      const [middlewareOptions] = vi.mocked(createExpressMiddleware).mock.calls.at(-1) ?? [];
      if (!middlewareOptions) throw new Error("Expected createExpressMiddleware to be called");

      const context = await middlewareOptions.createContext({
        req: { headers: {} },
        res: {},
      });

      expect(context.userId).toBeNull();
    });

    it("logs and reports internal server errors to Sentry via onError", () => {
      const [middlewareOptions] = vi.mocked(createExpressMiddleware).mock.calls.at(-1) ?? [];
      if (!middlewareOptions?.onError) {
        throw new Error("Expected onError to be defined");
      }
      vi.mocked(logger.error).mockClear();
      vi.mocked(Sentry.captureException).mockClear();

      const cause = new Error("db connection failed");
      const onError: (opts: {
        path: string;
        error: { message: string; code: string; cause?: unknown };
      }) => void = middlewareOptions.onError;
      onError({
        path: "user.get",
        error: { message: "Something went wrong", code: "INTERNAL_SERVER_ERROR", cause },
      });

      expect(vi.mocked(logger.error)).toHaveBeenCalledWith("[trpc] user.get: Something went wrong");
      expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledWith(cause, {
        tags: { trpcPath: "user.get" },
      });
    });

    it("does not report non-internal errors to Sentry", () => {
      const [middlewareOptions] = vi.mocked(createExpressMiddleware).mock.calls.at(-1) ?? [];
      if (!middlewareOptions?.onError) {
        throw new Error("Expected onError to be defined");
      }
      vi.mocked(Sentry.captureException).mockClear();

      const onError: (opts: { path: string; error: { message: string; code: string } }) => void =
        middlewareOptions.onError;
      onError({ path: "user.get", error: { message: "Not found", code: "NOT_FOUND" } });

      expect(vi.mocked(Sentry.captureException)).not.toHaveBeenCalled();
    });

    it("reports the error itself when no cause is present", () => {
      const [middlewareOptions] = vi.mocked(createExpressMiddleware).mock.calls.at(-1) ?? [];
      if (!middlewareOptions?.onError) {
        throw new Error("Expected onError to be defined");
      }
      vi.mocked(Sentry.captureException).mockClear();

      const errorObj = {
        message: "Internal failure",
        code: "INTERNAL_SERVER_ERROR",
        cause: undefined,
      };
      const onError: (opts: { path: string; error: typeof errorObj }) => void =
        middlewareOptions.onError;
      onError({ path: "data.list", error: errorObj });

      expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledWith(errorObj, {
        tags: { trpcPath: "data.list" },
      });
    });

    it("extracts first element when header is an array", async () => {
      const [middlewareOptions] = vi.mocked(createExpressMiddleware).mock.calls.at(-1) ?? [];
      if (!middlewareOptions) throw new Error("Expected createExpressMiddleware to be called");

      const context = await middlewareOptions.createContext({
        req: {
          headers: {
            "x-timezone": ["Europe/Berlin", "US/Pacific"],
            "x-app-version": ["1.0.0", "2.0.0"],
          },
        },
        res: {},
      });

      expect(context.timezone).toBe("Europe/Berlin");
      expect(context.appVersion).toBe("1.0.0");
    });

    it("returns undefined for non-string array header values", async () => {
      const [middlewareOptions] = vi.mocked(createExpressMiddleware).mock.calls.at(-1) ?? [];
      if (!middlewareOptions) throw new Error("Expected createExpressMiddleware to be called");

      const context = await middlewareOptions.createContext({
        req: {
          headers: {
            "x-app-version": [],
          },
        },
        res: {},
      });

      expect(context.appVersion).toBeUndefined();
    });
  });

  describe("createAuthRouter mounting", () => {
    it("calls createAuthRouter during app setup", () => {
      expect(vi.mocked(createAuthRouter)).toHaveBeenCalled();
    });
  });

  describe("route module mounting", () => {
    it("passes db and syncQueue to createWebhookRouter", () => {
      expect(vi.mocked(createWebhookRouter)).toHaveBeenCalledWith(
        expect.objectContaining({
          db: expect.anything(),
          syncQueue: expect.anything(),
        }),
      );
    });

    it("passes importQueue and db to createUploadRouter", () => {
      expect(vi.mocked(createUploadRouter)).toHaveBeenCalledWith(
        expect.objectContaining({
          importQueue: expect.anything(),
          db: expect.anything(),
        }),
      );
    });

    it("mounts materialized view refresh router", () => {
      expect(vi.mocked(createMaterializedViewRefreshRouter)).toHaveBeenCalled();
    });
  });
});

describe("runStartupTasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports warmCache errors to Sentry", async () => {
    const error = new Error("cache boom");
    vi.mocked(warmCache).mockRejectedValueOnce(error);
    vi.mocked(startSlackBot).mockResolvedValueOnce(undefined);

    const fakeDb = createDatabaseFromEnv();
    const app = express();
    runStartupTasks(fakeDb, app);

    // Let the microtask queue flush so .catch() handlers run
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(expect.stringContaining("cache boom"));
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledWith(error);
  });

  it("reports startSlackBot errors to Sentry", async () => {
    const error = new Error("slack boom");
    vi.mocked(warmCache).mockResolvedValueOnce(undefined);
    vi.mocked(startSlackBot).mockRejectedValueOnce(error);

    const fakeDb = createDatabaseFromEnv();
    const app = express();
    runStartupTasks(fakeDb, app);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(expect.stringContaining("slack boom"));
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledWith(error);
  });
});

describe("static file serving", () => {
  const distPath = fileURLToPath(new URL("../../web/dist", import.meta.url));
  const assetsPath = join(distPath, "assets");

  beforeAll(() => {
    mkdirSync(assetsPath, { recursive: true });
    writeFileSync(join(distPath, "index.html"), "<html><body>SPA</body></html>");
    writeFileSync(join(assetsPath, "app-abc123.js"), "console.log('app')");
  });

  afterAll(() => {
    rmSync(distPath, { recursive: true, force: true });
  });

  let baseUrl: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(getSessionIdFromRequest).mockReturnValue(undefined);
    vi.mocked(validateSession).mockResolvedValue(null);
    const fakeDb = createDatabaseFromEnv();
    const app = createApp(fakeDb);
    ({ baseUrl, close } = await startApp(app));
  });

  afterEach(async () => {
    await close();
  });

  it("serves index.html for SPA routes with no-cache header", async () => {
    const res = await fetch(`${baseUrl}/dashboard`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("SPA");
    expect(res.headers.get("cache-control")).toContain("no-cache");
  });

  it("serves static assets from /assets/", async () => {
    const res = await fetch(`${baseUrl}/assets/app-abc123.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("console.log('app')");
  });

  it("does not serve SPA fallback for /api/ routes", async () => {
    const res = await fetch(`${baseUrl}/api/trpc/nonexistent`);
    const body = await res.text();
    expect(body).not.toContain("SPA");
  });

  it("does not serve SPA fallback for /auth/ routes", async () => {
    const res = await fetch(`${baseUrl}/auth/something`);
    const body = await res.text();
    expect(body).not.toContain("SPA");
  });

  it("does not serve SPA fallback for /healthz", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });

  it("does not serve SPA fallback for /metrics", async () => {
    const res = await fetch(`${baseUrl}/metrics`);
    const body = await res.text();
    expect(body).not.toContain("SPA");
  });

  it("serves other static files from dist root", async () => {
    writeFileSync(join(distPath, "favicon.ico"), "icon");
    const res = await fetch(`${baseUrl}/favicon.ico`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("icon");
  });

  it("serves index.html for SPA routes even when process.cwd() points elsewhere", async () => {
    await close();
    const temporaryWorkingDirectory = mkdtempSync(join(tmpdir(), "dofek-server-cwd-"));
    const workingDirectorySpy = vi.spyOn(process, "cwd").mockReturnValue(temporaryWorkingDirectory);

    try {
      const fakeDb = createDatabaseFromEnv();
      const app = createApp(fakeDb);
      ({ baseUrl, close } = await startApp(app));

      const res = await fetch(`${baseUrl}/dashboard`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("SPA");
    } finally {
      workingDirectorySpy.mockRestore();
      rmSync(temporaryWorkingDirectory, { recursive: true, force: true });
    }
  });
});

describe("main", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  afterEach(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it("throws when DATABASE_URL is not set", async () => {
    delete process.env.DATABASE_URL;
    await expect(main()).rejects.toThrow("DATABASE_URL environment variable is required");
  });

  it("creates db and app when DATABASE_URL is set", async () => {
    process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
    vi.mocked(createDatabaseFromEnv).mockClear();
    vi.mocked(logger.info).mockClear();

    // main() calls app.listen which binds a port — use port 0 via env
    const originalPort = process.env.PORT;
    process.env.PORT = "0";

    try {
      // main() returns after calling app.listen (non-blocking)
      await main();
      // Give the listen callback time to fire
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(vi.mocked(createDatabaseFromEnv)).toHaveBeenCalled();
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(expect.stringContaining("API running"));
    } finally {
      if (originalPort === undefined) {
        delete process.env.PORT;
      } else {
        process.env.PORT = originalPort;
      }
    }
  });
});
