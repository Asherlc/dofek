import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../auth/cookies.ts", () => ({
  getSessionCookie: vi.fn(),
}));

vi.mock("../auth/session.ts", () => ({
  validateSession: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("../lib/server-utils.ts", () => ({
  errorMessage: vi.fn((err: unknown) => (err instanceof Error ? err.message : String(err))),
}));

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

vi.mock("dofek/db", () => ({
  createDatabaseFromEnv: vi.fn(() => ({})),
}));

import type { AddressInfo } from "node:net";
import cookieParser from "cookie-parser";
import { createDatabaseFromEnv } from "dofek/db";
import express from "express";
import { getSessionCookie } from "../auth/cookies.ts";
import { validateSession } from "../auth/session.ts";
import { createExportRouter } from "./export.ts";

function createTestApp() {
  const fakeDb = createDatabaseFromEnv();
  const app = express();
  app.use(cookieParser());
  app.use("/api/export", createExportRouter(fakeDb));
  return { app };
}

function getPort(server: ReturnType<express.Express["listen"]>): number {
  const addr = server.address();
  if (addr !== null && typeof addr === "object") {
    return (addr satisfies AddressInfo).port;
  }
  throw new Error("Server address is not an object");
}

async function request(
  app: express.Express,
  method: "get" | "post",
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = getPort(server);
      fetch(`http://localhost:${port}${path}`, { method: method.toUpperCase() })
        .then(async (res) => {
          resolve({ status: res.status, body: await res.text() });
          server.close();
        })
        .catch(() => {
          resolve({ status: 500, body: "fetch error" });
          server.close();
        });
    });
  });
}

describe("createExportRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /api/export", () => {
    it("returns 401 when not authenticated", async () => {
      vi.mocked(getSessionCookie).mockReturnValue(undefined);
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/export");
      expect(res.status).toBe(401);
    });

    it("returns 401 when session expired", async () => {
      vi.mocked(getSessionCookie).mockReturnValue("sess-1");
      vi.mocked(validateSession).mockResolvedValue(null);
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/export");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/export/status/:jobId", () => {
    it("returns 401 when not authenticated", async () => {
      // First create a job while authenticated
      vi.mocked(getSessionCookie).mockReturnValue("sess-1");
      vi.mocked(validateSession).mockResolvedValue({ userId: "user-1" });
      const { app } = createTestApp();
      const postRes = await request(app, "post", "/api/export");
      const { jobId } = JSON.parse(postRes.body);

      // Now try to access status without auth
      vi.mocked(getSessionCookie).mockReturnValue(undefined);
      const statusRes = await request(app, "get", `/api/export/status/${jobId}`);
      expect(statusRes.status).toBe(401);
    });

    it("returns 403 when job belongs to another user", async () => {
      // Create a job as user-1
      vi.mocked(getSessionCookie).mockReturnValue("sess-1");
      vi.mocked(validateSession).mockResolvedValue({ userId: "user-1" });
      const { app } = createTestApp();
      const postRes = await request(app, "post", "/api/export");
      const { jobId } = JSON.parse(postRes.body);

      // Try to access status as user-2
      vi.mocked(getSessionCookie).mockReturnValue("sess-2");
      vi.mocked(validateSession).mockResolvedValue({ userId: "user-2" });
      const statusRes = await request(app, "get", `/api/export/status/${jobId}`);
      expect(statusRes.status).toBe(403);
    });

    it("returns 404 for unknown job", async () => {
      vi.mocked(getSessionCookie).mockReturnValue("sess-1");
      vi.mocked(validateSession).mockResolvedValue({ userId: "user-1" });
      const { app } = createTestApp();
      const res = await request(app, "get", "/api/export/status/unknown-job");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/export (with valid session)", () => {
    it("starts export and returns processing status", async () => {
      vi.mocked(getSessionCookie).mockReturnValue("sess-1");
      vi.mocked(validateSession).mockResolvedValue({
        userId: "user-1",
        expiresAt: new Date("2027-01-01"),
      });
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/export");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.status).toBe("processing");
      expect(data.jobId).toBeDefined();
    });
  });

  describe("GET /api/export/download/:jobId", () => {
    it("returns 401 when not authenticated", async () => {
      vi.mocked(getSessionCookie).mockReturnValue(undefined);
      const { app } = createTestApp();
      const res = await request(app, "get", "/api/export/download/some-job");
      expect(res.status).toBe(401);
    });

    it("returns 401 when session expired", async () => {
      vi.mocked(getSessionCookie).mockReturnValue("sess-1");
      vi.mocked(validateSession).mockResolvedValue(null);
      const { app } = createTestApp();
      const res = await request(app, "get", "/api/export/download/some-job");
      expect(res.status).toBe(401);
    });

    it("returns 404 for unknown job with valid session", async () => {
      vi.mocked(getSessionCookie).mockReturnValue("sess-1");
      vi.mocked(validateSession).mockResolvedValue({
        userId: "user-1",
        expiresAt: new Date("2027-01-01"),
      });
      const { app } = createTestApp();
      const res = await request(app, "get", "/api/export/download/unknown-job");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/export/status/:jobId (after export starts)", () => {
    it("returns job status for known job", async () => {
      vi.mocked(getSessionCookie).mockReturnValue("sess-1");
      vi.mocked(validateSession).mockResolvedValue({
        userId: "user-1",
        expiresAt: new Date("2027-01-01"),
      });
      const { app } = createTestApp();

      // Start an export to create a job
      const postRes = await request(app, "post", "/api/export");
      const { jobId } = JSON.parse(postRes.body);

      // Check status — job exists and returns a known status
      const statusRes = await request(app, "get", `/api/export/status/${jobId}`);
      expect(statusRes.status).toBe(200);
      const data = JSON.parse(statusRes.body);
      // Status will be "processing" or "error" depending on timing of background task
      expect(["processing", "error"]).toContain(data.status);
    });
  });

  describe("GET /api/export/download/:jobId (forbidden/not ready)", () => {
    it("returns 403 when job belongs to another user", async () => {
      // Start export as user-1
      vi.mocked(getSessionCookie).mockReturnValue("sess-1");
      vi.mocked(validateSession).mockResolvedValue({
        userId: "user-1",
        expiresAt: new Date("2027-01-01"),
      });
      const { app } = createTestApp();
      const postRes = await request(app, "post", "/api/export");
      const { jobId } = JSON.parse(postRes.body);

      // Try to download as user-2
      vi.mocked(validateSession).mockResolvedValue({
        userId: "user-2",
        expiresAt: new Date("2027-01-01"),
      });
      const res = await request(app, "get", `/api/export/download/${jobId}`);
      expect(res.status).toBe(403);
    });

    it("returns 400 when export is not done yet", async () => {
      vi.mocked(getSessionCookie).mockReturnValue("sess-1");
      vi.mocked(validateSession).mockResolvedValue({
        userId: "user-1",
        expiresAt: new Date("2027-01-01"),
      });
      const { app } = createTestApp();
      const postRes = await request(app, "post", "/api/export");
      const { jobId } = JSON.parse(postRes.body);

      // Try to download while still processing
      const res = await request(app, "get", `/api/export/download/${jobId}`);
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).error).toBe("Export not ready");
    });
  });
});
