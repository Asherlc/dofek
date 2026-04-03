import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("dofek/lib/r2-client", () => ({
  createR2Client: vi.fn(),
  createS3Client: vi.fn(),
  parseR2Config: vi.fn(),
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
vi.mock("./routes/auth.ts", () => ({
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
vi.mock("./routes/upload.ts", () => ({
  createUploadRouter: vi.fn(() => {
    const { Router } = require("express");
    return Router();
  }),
}));
vi.mock("./routes/updates.ts", () => ({
  createUpdatesRouter: vi.fn(() => {
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
import {
  createExportQueue,
  createImportQueue,
  createPostSyncQueue,
  createScheduledSyncQueue,
  createSyncQueue,
  createTrainingExportQueue,
} from "dofek/jobs/queues";
import { createR2Client, createS3Client, parseR2Config, type R2Config } from "dofek/lib/r2-client";
import express from "express";
import { isAdmin } from "./auth/admin.ts";
import { getSessionIdFromRequest } from "./auth/cookies.ts";
import { validateSession } from "./auth/session.ts";
import { createApp, runStartupTasks } from "./index.ts";
import { httpRequestDuration, registry } from "./lib/metrics.ts";
import { warmCache } from "./lib/warm-cache.ts";
import { logger } from "./logger.ts";
import { createAuthRouter } from "./routes/auth.ts";
import { createUpdatesRouter } from "./routes/updates.ts";
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
        expect.objectContaining({ method: "GET" }),
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

    it("initializes Bull Board only once across multiple admin requests", async () => {
      const { createBullBoard: mockCreateBullBoard } = await import("@bull-board/api");
      vi.mocked(mockCreateBullBoard).mockClear();
      vi.mocked(getSessionIdFromRequest).mockReturnValue("admin-session");
      vi.mocked(validateSession).mockResolvedValue({
        userId: "admin-1",
        expiresAt: new Date("2027-01-01"),
      });
      vi.mocked(isAdmin).mockResolvedValue(true);

      await fetch(`${baseUrl}/admin/queues`);
      await fetch(`${baseUrl}/admin/queues`);

      // createBullBoard should only be called once (lazy init)
      expect(vi.mocked(mockCreateBullBoard)).toHaveBeenCalledTimes(1);
    });

    it("registers all 6 queue types with Bull Board", async () => {
      const { createBullBoard: mockCreateBullBoard } = await import("@bull-board/api");
      const { BullMQAdapter: MockBullMQAdapter } = await import("@bull-board/api/bullMQAdapter");
      vi.mocked(mockCreateBullBoard).mockClear();
      vi.mocked(MockBullMQAdapter).mockClear();
      vi.mocked(getSessionIdFromRequest).mockReturnValue("admin-session");
      vi.mocked(validateSession).mockResolvedValue({
        userId: "admin-1",
        expiresAt: new Date("2027-01-01"),
      });
      vi.mocked(isAdmin).mockResolvedValue(true);

      await fetch(`${baseUrl}/admin/queues`);

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
      // Verify the exact count to catch accidental omissions
      const call = vi.mocked(mockCreateBullBoard).mock.calls[0][0];
      expect(call.queues).toHaveLength(6);
    });

    it("calls each queue factory exactly once (lazy init)", async () => {
      vi.mocked(createExportQueue).mockClear();
      vi.mocked(createScheduledSyncQueue).mockClear();
      vi.mocked(createPostSyncQueue).mockClear();
      vi.mocked(createTrainingExportQueue).mockClear();
      vi.mocked(createImportQueue).mockClear();
      vi.mocked(createSyncQueue).mockClear();
      vi.mocked(getSessionIdFromRequest).mockReturnValue("admin-session");
      vi.mocked(validateSession).mockResolvedValue({
        userId: "admin-1",
        expiresAt: new Date("2027-01-01"),
      });
      vi.mocked(isAdmin).mockResolvedValue(true);

      await fetch(`${baseUrl}/admin/queues`);

      expect(vi.mocked(createSyncQueue)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(createImportQueue)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(createExportQueue)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(createScheduledSyncQueue)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(createPostSyncQueue)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(createTrainingExportQueue)).toHaveBeenCalledTimes(1);
    });

    it("passes queue factory results to BullMQAdapter", async () => {
      const { BullMQAdapter: MockBullMQAdapter } = await import("@bull-board/api/bullMQAdapter");
      vi.mocked(MockBullMQAdapter).mockClear();
      vi.mocked(getSessionIdFromRequest).mockReturnValue("admin-session");
      vi.mocked(validateSession).mockResolvedValue({
        userId: "admin-1",
        expiresAt: new Date("2027-01-01"),
      });
      vi.mocked(isAdmin).mockResolvedValue(true);

      await fetch(`${baseUrl}/admin/queues`);

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
    it("returns 404 when no dev-session exists", async () => {
      const res = await fetch(`${baseUrl}/auth/dev-login`, { redirect: "manual" });
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).toContain("No dev-session found");
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
  });

  describe("createAuthRouter mounting", () => {
    it("calls createAuthRouter during app setup", () => {
      expect(vi.mocked(createAuthRouter)).toHaveBeenCalled();
    });
  });

  describe("route module mounting", () => {
    it("passes default config to createUpdatesRouter", () => {
      expect(vi.mocked(createUpdatesRouter)).toHaveBeenCalledWith(
        expect.objectContaining({
          updatesDir: "/app/updates",
          updatesPrefix: "mobile-ota",
          publicUrl: "https://dofek.asherlc.com",
        }),
      );
    });

    it("passes db and getSyncQueue to createWebhookRouter", () => {
      expect(vi.mocked(createWebhookRouter)).toHaveBeenCalledWith(
        expect.objectContaining({
          db: expect.anything(),
          getSyncQueue: expect.any(Function),
        }),
      );
    });

    it("passes getImportQueue and db to createUploadRouter", () => {
      expect(vi.mocked(createUploadRouter)).toHaveBeenCalledWith(
        expect.objectContaining({
          getImportQueue: expect.any(Function),
          db: expect.anything(),
        }),
      );
    });
  });

  describe("R2 OTA configuration", () => {
    const r2EnvKeys = [
      "R2_ENDPOINT",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "R2_BUCKET",
    ] as const;
    const originalR2Env: Record<(typeof r2EnvKeys)[number], string | undefined> = {
      R2_ENDPOINT: process.env.R2_ENDPOINT,
      R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
      R2_BUCKET: process.env.R2_BUCKET,
    };

    function setR2Env(values: Partial<Record<(typeof r2EnvKeys)[number], string>>) {
      for (const key of r2EnvKeys) {
        const value = values[key];
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }

    afterEach(() => {
      for (const key of r2EnvKeys) {
        const originalValue = originalR2Env[key];
        if (originalValue === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = originalValue;
        }
      }
    });

    it("logs fallback when R2 config is incomplete", () => {
      setR2Env({
        R2_ENDPOINT: "https://example.r2.cloudflarestorage.com",
      });

      const fakeDb = createDatabaseFromEnv();
      createApp(fakeDb);

      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        "[updates] Incomplete R2 config; falling back to filesystem OTA storage",
      );
      expect(vi.mocked(parseR2Config)).not.toHaveBeenCalled();
    });

    it("logs and reports invalid complete R2 config", () => {
      setR2Env({
        R2_ENDPOINT: "https://example.r2.cloudflarestorage.com",
        R2_ACCESS_KEY_ID: "key-id",
        R2_SECRET_ACCESS_KEY: "secret",
        R2_BUCKET: "ota-assets",
      });
      const parseError = new Error("bad r2 config");
      vi.mocked(parseR2Config).mockImplementationOnce(() => {
        throw parseError;
      });

      const fakeDb = createDatabaseFromEnv();
      createApp(fakeDb);

      expect(vi.mocked(parseR2Config)).toHaveBeenCalled();
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        expect.stringContaining("Invalid R2 config; falling back to filesystem OTA storage"),
      );
      expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledWith(parseError);
      expect(vi.mocked(createS3Client)).not.toHaveBeenCalled();
      expect(vi.mocked(createR2Client)).not.toHaveBeenCalled();
    });

    it("builds an R2 client when complete config is valid", () => {
      setR2Env({
        R2_ENDPOINT: "https://example.r2.cloudflarestorage.com",
        R2_ACCESS_KEY_ID: "key-id",
        R2_SECRET_ACCESS_KEY: "secret",
        R2_BUCKET: "ota-assets",
      });
      const parsedConfig: R2Config = {
        R2_ENDPOINT: "https://example.r2.cloudflarestorage.com",
        R2_ACCESS_KEY_ID: "key-id",
        R2_SECRET_ACCESS_KEY: "secret",
        R2_BUCKET: "ota-assets",
      };
      vi.mocked(parseR2Config).mockReturnValueOnce(parsedConfig);

      const fakeDb = createDatabaseFromEnv();
      createApp(fakeDb);

      expect(vi.mocked(parseR2Config)).toHaveBeenCalledWith(parsedConfig);
      expect(vi.mocked(createS3Client)).toHaveBeenCalledWith(parsedConfig);
      expect(vi.mocked(createR2Client)).toHaveBeenCalledWith(undefined, "ota-assets");
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        "[updates] Using R2 object storage for OTA assets",
      );
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
