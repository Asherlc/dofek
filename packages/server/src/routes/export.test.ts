import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../auth/cookies.ts", () => ({
  getSessionIdFromRequest: vi.fn(),
}));

vi.mock("../auth/session.ts", () => ({
  validateSession: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("../lib/start-worker.ts", () => ({
  startWorker: vi.fn(),
}));

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const mockUnlink = vi.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined);
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, unlink: (...args: [string]) => mockUnlink(...args) };
});

vi.mock("dofek/db", () => ({
  createDatabaseFromEnv: vi.fn(() => ({})),
}));

// Mock BullMQ queue
const mockJob = {
  id: "42",
  data: { userId: "user-1", outputPath: "/tmp/dofek-export-42.zip" },
  progress: { percentage: 0, message: "Starting export..." },
  getState: vi.fn().mockResolvedValue("active"),
  remove: vi.fn().mockResolvedValue(undefined),
  failedReason: "",
};

const mockQueue = {
  add: vi.fn().mockResolvedValue(mockJob),
  getJob: vi.fn().mockResolvedValue(mockJob),
};

import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cookieParser from "cookie-parser";
import { createDatabaseFromEnv } from "dofek/db";
import express from "express";
import { getSessionIdFromRequest } from "../auth/cookies.ts";
import { validateSession } from "../auth/session.ts";
import { logger } from "../logger.ts";
import { createExportRouter } from "./export.ts";

function createTestApp() {
  const fakeDb = createDatabaseFromEnv();
  const app = express();
  app.use(cookieParser());
  app.use("/api/export", createExportRouter({ db: fakeDb, exportQueue: mockQueue }));
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
        .catch((_error: unknown) => {
          resolve({ status: 500, body: "fetch error" });
          server.close();
        });
    });
  });
}

describe("createExportRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockJob.data = { userId: "user-1", outputPath: "/tmp/dofek-export-42.zip" };
    mockJob.progress = { percentage: 0, message: "Starting export..." };
    mockJob.getState.mockResolvedValue("active");
    mockQueue.add.mockResolvedValue(mockJob);
    mockQueue.getJob.mockResolvedValue(mockJob);
  });

  describe("POST /api/export", () => {
    it("returns 401 when not authenticated", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue(undefined);
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/export");
      expect(res.status).toBe(401);
    });

    it("returns 401 when session expired", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue("sess-1");
      vi.mocked(validateSession).mockResolvedValue(null);
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/export");
      expect(res.status).toBe(401);
    });

    it("enqueues a BullMQ job and returns jobId", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue("sess-1");
      vi.mocked(validateSession).mockResolvedValue({ userId: "user-1" });
      const { app } = createTestApp();

      const res = await request(app, "post", "/api/export");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.status).toBe("processing");
      expect(data.jobId).toBe("42");
      expect(mockQueue.add).toHaveBeenCalledWith(
        "export",
        expect.objectContaining({
          userId: "user-1",
          outputPath: expect.stringContaining("dofek-export-"),
        }),
      );
    });
  });

  describe("GET /api/export/status/:jobId", () => {
    it("returns 401 when not authenticated", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue(undefined);
      const { app } = createTestApp();
      const res = await request(app, "get", "/api/export/status/42");
      expect(res.status).toBe(401);
    });

    it("returns 404 for unknown job", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue("sess-1");
      vi.mocked(validateSession).mockResolvedValue({ userId: "user-1" });
      mockQueue.getJob.mockResolvedValue(null);
      const { app } = createTestApp();
      const res = await request(app, "get", "/api/export/status/unknown");
      expect(res.status).toBe(404);
    });

    it("returns 403 when job belongs to another user", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue("sess-2");
      vi.mocked(validateSession).mockResolvedValue({ userId: "user-2" });
      mockJob.data = { userId: "user-1", outputPath: "/tmp/test.zip" };
      const { app } = createTestApp();
      const res = await request(app, "get", "/api/export/status/42");
      expect(res.status).toBe(403);
    });

    it("returns processing status with progress", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue("sess-1");
      vi.mocked(validateSession).mockResolvedValue({ userId: "user-1" });
      mockJob.progress = { percentage: 50, message: "Exporting activities.json..." };
      mockJob.getState.mockResolvedValue("active");
      const { app } = createTestApp();

      const res = await request(app, "get", "/api/export/status/42");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.status).toBe("processing");
      expect(data.progress).toBe(50);
      expect(data.message).toBe("Exporting activities.json...");
    });

    it("returns done status with download URL when completed", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue("sess-1");
      vi.mocked(validateSession).mockResolvedValue({ userId: "user-1" });
      mockJob.progress = { percentage: 100, message: "Export complete" };
      mockJob.getState.mockResolvedValue("completed");
      const { app } = createTestApp();

      const res = await request(app, "get", "/api/export/status/42");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.status).toBe("done");
      expect(data.downloadUrl).toBe("/api/export/download/42");
    });

    it("returns error status when job failed", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue("sess-1");
      vi.mocked(validateSession).mockResolvedValue({ userId: "user-1" });
      mockJob.getState.mockResolvedValue("failed");
      mockJob.failedReason = "DB connection lost";
      const { app } = createTestApp();

      const res = await request(app, "get", "/api/export/status/42");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.status).toBe("error");
      expect(data.message).toBe("DB connection lost");

      mockJob.failedReason = "";
    });
  });

  describe("GET /api/export/download/:jobId", () => {
    it("returns 401 when not authenticated", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue(undefined);
      const { app } = createTestApp();
      const res = await request(app, "get", "/api/export/download/42");
      expect(res.status).toBe(401);
    });

    it("returns 401 when session expired", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue("sess-1");
      vi.mocked(validateSession).mockResolvedValue(null);
      const { app } = createTestApp();
      const res = await request(app, "get", "/api/export/download/42");
      expect(res.status).toBe(401);
    });

    it("returns 404 for unknown job", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue("sess-1");
      vi.mocked(validateSession).mockResolvedValue({ userId: "user-1" });
      mockQueue.getJob.mockResolvedValue(null);
      const { app } = createTestApp();
      const res = await request(app, "get", "/api/export/download/unknown");
      expect(res.status).toBe(404);
    });

    it("returns 403 when job belongs to another user", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue("sess-2");
      vi.mocked(validateSession).mockResolvedValue({ userId: "user-2" });
      const { app } = createTestApp();
      const res = await request(app, "get", "/api/export/download/42");
      expect(res.status).toBe(403);
    });

    it("returns 400 when export is not done yet", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue("sess-1");
      vi.mocked(validateSession).mockResolvedValue({ userId: "user-1" });
      mockJob.getState.mockResolvedValue("active");
      const { app } = createTestApp();
      const res = await request(app, "get", "/api/export/download/42");
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).error).toBe("Export not ready");
    });

    it("returns 404 when export file is missing", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue("sess-1");
      vi.mocked(validateSession).mockResolvedValue({ userId: "user-1" });
      mockJob.getState.mockResolvedValue("completed");
      mockJob.data = { userId: "user-1", outputPath: "/tmp/nonexistent.zip" };
      const { app } = createTestApp();
      const res = await request(app, "get", "/api/export/download/42");
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body).error).toBe("Export file not found");
    });

    it("warns when unlink fails after download", async () => {
      const tempFile = join(tmpdir(), `dofek-export-test-${Date.now()}.zip`);
      writeFileSync(tempFile, "fake-zip-data");

      vi.mocked(getSessionIdFromRequest).mockReturnValue("sess-1");
      vi.mocked(validateSession).mockResolvedValue({ userId: "user-1" });
      mockJob.getState.mockResolvedValue("completed");
      mockJob.data = { userId: "user-1", outputPath: tempFile };
      mockUnlink.mockRejectedValueOnce(new Error("EPERM"));

      const { app } = createTestApp();
      const res = await request(app, "get", "/api/export/download/42");
      expect(res.status).toBe(200);

      // Wait for the download callback's async cleanup to settle
      await vi.waitFor(() => {
        expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
          "Failed to clean up export file %s: %s",
          tempFile,
          expect.any(Error),
        );
      });
    });

    it("warns when job.remove fails after download", async () => {
      const tempFile = join(tmpdir(), `dofek-export-test-${Date.now()}.zip`);
      writeFileSync(tempFile, "fake-zip-data");

      vi.mocked(getSessionIdFromRequest).mockReturnValue("sess-1");
      vi.mocked(validateSession).mockResolvedValue({ userId: "user-1" });
      mockJob.getState.mockResolvedValue("completed");
      mockJob.data = { userId: "user-1", outputPath: tempFile };
      mockJob.remove.mockRejectedValueOnce(new Error("Redis down"));

      const { app } = createTestApp();
      const res = await request(app, "get", "/api/export/download/42");
      expect(res.status).toBe(200);

      await vi.waitFor(() => {
        expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
          "Failed to remove export job: %s",
          expect.any(Error),
        );
      });
    });
  });
});
