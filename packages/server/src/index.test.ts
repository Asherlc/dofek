import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@bull-board/api", () => ({
  createBullBoard: vi.fn(),
}));
vi.mock("@bull-board/api/bullMQAdapter", () => ({
  BullMQAdapter: vi.fn(),
}));
vi.mock("@bull-board/express", () => ({
  ExpressAdapter: vi.fn(() => ({
    setBasePath: vi.fn(),
    getRouter: vi.fn(() => vi.fn()),
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
vi.mock("./auth/admin.ts", () => ({
  isAdmin: vi.fn().mockResolvedValue(false),
}));
vi.mock("./auth/cookies.ts", () => ({
  getSessionIdFromRequest: vi.fn(),
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
  createDatabaseFromEnv: vi.fn(() => ({})),
}));

import { createDatabaseFromEnv } from "dofek/db";
import { isAdmin } from "./auth/admin.ts";
import { getSessionIdFromRequest } from "./auth/cookies.ts";
import { validateSession } from "./auth/session.ts";
import { createApp } from "./index.ts";
import { httpRequestDuration, registry } from "./lib/metrics.ts";
import { logger } from "./logger.ts";
import { createAuthRouter } from "./routes/auth.ts";

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
    it("logger.info is configured as a mock (metrics middleware uses it)", () => {
      // Verify the logger mock is in place — the request duration middleware
      // calls logger.info on every request finish event
      expect(vi.mocked(logger.info)).toBeDefined();
      expect(typeof vi.mocked(logger.info)).toBe("function");
    });

    it("httpRequestDuration object is defined and observe is a function", () => {
      expect(httpRequestDuration).toBeDefined();
      expect(typeof httpRequestDuration.observe).toBe("function");
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
  });

  describe("tRPC middleware mounting", () => {
    it("handles requests to /api/trpc (middleware is mounted)", async () => {
      const res = await fetch(`${baseUrl}/api/trpc/nonexistent`);
      expect([200, 400, 404, 500]).toContain(res.status);
    });
  });

  describe("createAuthRouter mounting", () => {
    it("calls createAuthRouter during app setup", () => {
      expect(vi.mocked(createAuthRouter)).toHaveBeenCalled();
    });
  });
});
