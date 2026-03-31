import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  init: vi.fn(),
}));
vi.mock("@bull-board/api", () => ({
  createBullBoard: vi.fn(),
}));
vi.mock("@bull-board/api/bullMQAdapter", () => ({
  BullMQAdapter: vi.fn(),
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
  createImportQueue: vi.fn(),
  createSyncQueue: vi.fn(),
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
  });

  describe("createAuthRouter mounting", () => {
    it("calls createAuthRouter during app setup", () => {
      expect(vi.mocked(createAuthRouter)).toHaveBeenCalled();
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
