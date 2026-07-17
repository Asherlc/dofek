import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/server-utils.ts", () => ({
  MAX_UPLOAD_BYTES: 2 * 1024 * 1024 * 1024,
  streamToFile: vi.fn(() => Promise.resolve(1)),
  assembleChunks: vi.fn(() => Promise.resolve()),
}));

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
}));

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const mockRm = vi
  .fn<(path: string, options?: object) => Promise<void>>()
  .mockResolvedValue(undefined);
const mockRename = vi
  .fn<(oldPath: string, newPath: string) => Promise<void>>()
  .mockResolvedValue(undefined);
const mockUnlink = vi.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined);
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: (...args: [string, object?]) => mockRm(...args),
    rename: (oldPath: string, newPath: string) => mockRename(oldPath, newPath),
    unlink: (path: string) => mockUnlink(path),
  };
});

vi.mock("../auth/cookies.ts", () => ({
  getSessionIdFromRequest: vi.fn(),
}));

vi.mock("../auth/session.ts", () => ({
  validateSession: vi.fn(() => Promise.resolve(null)),
}));

import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { getSessionIdFromRequest } from "../auth/cookies.ts";
import { validateSession } from "../auth/session.ts";
import { assembleChunks, streamToFile } from "../lib/server-utils.ts";
import { getUploadStateStore } from "../lib/upload-state-store.ts";
import { logger } from "../logger.ts";
import { createUploadRouter } from "./upload.ts";

const EXPECTED_JOB_FILES_DIR = process.env.JOB_FILES_DIR || join(tmpdir(), "dofek-job-files");

function mockQueue() {
  const mockJob = {
    id: "job-123",
    getState: vi.fn(),
    progress: 0,
    failedReason: null,
    returnvalue: null,
    data: { userId: "user-1" },
  };
  return {
    add: vi.fn(() => Promise.resolve(mockJob)),
    getJob: vi.fn(() => Promise.resolve(mockJob)),
  };
}

function createTestApp() {
  const queue = mockQueue();
  const fakeDb = {} satisfies import("dofek/db").Database;
  const app = express();
  app.use(
    "/api/upload",
    createUploadRouter({
      importQueue: queue,
      db: fakeDb,
    }),
  );
  return { app, queue };
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
  opts?: { headers?: Record<string, string>; body?: Buffer },
): Promise<{ status: number; body: string; headers: Headers }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = getPort(server);
      const abortController = new AbortController();
      let settled = false;
      const timeout = setTimeout(() => {
        abortController.abort();
        finish({ status: 504, body: "timeout", headers: new Headers() });
      }, 5_000);
      const finish = (result: { status: number; body: string; headers: Headers }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
        server.close();
      };
      const fetchOpts: RequestInit = {
        method: method.toUpperCase(),
        headers: opts?.headers,
        body: opts?.body,
        signal: abortController.signal,
      };
      fetch(`http://localhost:${port}${path}`, fetchOpts)
        .then(async (res) => {
          finish({ status: res.status, body: await res.text(), headers: res.headers });
        })
        .catch((_error: unknown) => {
          finish({ status: 500, body: "fetch error", headers: new Headers() });
        });
    });
  });
}

async function rawRequest(
  app: express.Express,
  method: "GET" | "POST",
  path: string,
  opts?: { headers?: Record<string, string>; body?: Buffer },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let server: ReturnType<express.Express["listen"]> | undefined;
    const finish = (result: { status: number; body: string } | Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      const complete = () => {
        if (result instanceof Error) {
          reject(result);
          return;
        }
        resolve(result);
      };
      if (!server?.listening) {
        complete();
        return;
      }
      server.close(complete);
    };
    try {
      server = app.listen(0, () => {
        timeout = setTimeout(() => {
          finish(new Error("raw request timed out"));
        }, 5_000);
        const listeningServer = server;
        if (!listeningServer) {
          finish(new Error("raw request server was not initialized"));
          return;
        }
        let port: number;
        try {
          port = getPort(listeningServer);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        const req = httpRequest(
          {
            port,
            path,
            method,
            headers: opts?.headers,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => {
              finish({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf8"),
              });
            });
          },
        );
        req.on("error", (error) => {
          finish(error);
        });
        req.end(opts?.body);
      });
      server.on("error", (error) => {
        finish(error);
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

describe("createUploadRouter", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const uploadStateStore = getUploadStateStore();
    for (const uploadId of [
      "upload-abc",
      "status-job",
      "upload-full",
      "upload-assembly-err",
      "upload-rm-assembly-err",
      "upload-assemble-dir",
      "strong-chunked",
      "garmin-chunked",
      "garmin-too-large",
      "garmin-too-many-chunks",
    ]) {
      await uploadStateStore.deleteUploadSession(uploadId);
      await uploadStateStore.deleteUploadStatus(uploadId);
    }
    vi.mocked(getSessionIdFromRequest).mockReturnValue("sess-1");
    vi.mocked(validateSession).mockResolvedValue({ userId: "user-1" });
  });

  describe("authentication", () => {
    it("returns 401 for unauthenticated POST /apple-health", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue(undefined);
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/upload/apple-health", {
        headers: { "Content-Type": "application/zip" },
        body: Buffer.from("data"),
      });
      expect(res.status).toBe(401);
    });

    it("returns 401 for expired session on POST /apple-health", async () => {
      vi.mocked(validateSession).mockResolvedValue(null);
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/upload/apple-health", {
        headers: { "Content-Type": "application/zip" },
        body: Buffer.from("data"),
      });
      expect(res.status).toBe(401);
    });

    it("returns 401 for unauthenticated POST /strong-csv", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue(undefined);
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/upload/strong-csv", {
        headers: { "Content-Type": "text/csv" },
        body: Buffer.from("data"),
      });
      expect(res.status).toBe(401);
    });

    it("returns 401 for unauthenticated POST /cronometer-csv", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue(undefined);
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/upload/cronometer-csv", {
        headers: { "Content-Type": "text/csv" },
        body: Buffer.from("data"),
      });
      expect(res.status).toBe(401);
    });

    it("returns 401 for unauthenticated POST /kaya-export", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue(undefined);
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/upload/kaya-export", {
        headers: { "Content-Type": "text/csv" },
        body: Buffer.from("data"),
      });
      expect(res.status).toBe(401);
    });

    it("returns 401 for unauthenticated POST /garmin-dump", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue(undefined);
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/upload/garmin-dump", {
        headers: { "Content-Type": "application/zip" },
        body: Buffer.from("data"),
      });
      expect(res.status).toBe(401);
      expect(streamToFile).not.toHaveBeenCalled();
    });

    it("returns 401 for unauthenticated POST /fit-file", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue(undefined);
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/upload/fit-file", {
        headers: { "Content-Type": "application/octet-stream" },
        body: Buffer.from("fit-data"),
      });
      expect(res.status).toBe(401);
      expect(streamToFile).not.toHaveBeenCalled();
    });

    it("returns 401 for unauthenticated GET /apple-health/status", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue(undefined);
      const { app } = createTestApp();
      const res = await request(app, "get", "/api/upload/apple-health/status/job-1");
      expect(res.status).toBe(401);
    });

    it("returns 401 for unauthenticated GET /strong-csv/status", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue(undefined);
      const { app } = createTestApp();
      const res = await request(app, "get", "/api/upload/strong-csv/status/job-1");
      expect(res.status).toBe(401);
    });

    it("returns 401 for unauthenticated GET /cronometer-csv/status", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue(undefined);
      const { app } = createTestApp();
      const res = await request(app, "get", "/api/upload/cronometer-csv/status/job-1");
      expect(res.status).toBe(401);
    });

    it("returns 401 for unauthenticated GET /kaya-export/status", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue(undefined);
      const { app } = createTestApp();
      const res = await request(app, "get", "/api/upload/kaya-export/status/job-1");
      expect(res.status).toBe(401);
    });

    it("uses authenticated userId for apple-health upload", async () => {
      const { app, queue } = createTestApp();
      await request(app, "post", "/api/upload/apple-health", {
        headers: { "Content-Type": "application/zip" },
        body: Buffer.from("data"),
      });
      expect(queue.add).toHaveBeenCalledWith(
        "apple-health",
        expect.objectContaining({ userId: "user-1" }),
        undefined,
      );
    });

    it("uses authenticated userId for strong-csv upload", async () => {
      const { app, queue } = createTestApp();
      await request(app, "post", "/api/upload/strong-csv", {
        headers: { "Content-Type": "text/csv" },
        body: Buffer.from("data"),
      });
      expect(queue.add).toHaveBeenCalledWith(
        "strong-csv",
        expect.objectContaining({ userId: "user-1" }),
        undefined,
      );
    });

    it("uses authenticated userId for cronometer-csv upload", async () => {
      const { app, queue } = createTestApp();
      await request(app, "post", "/api/upload/cronometer-csv", {
        headers: { "Content-Type": "text/csv" },
        body: Buffer.from("data"),
      });
      expect(queue.add).toHaveBeenCalledWith(
        "cronometer-csv",
        expect.objectContaining({ userId: "user-1" }),
        undefined,
      );
    });

    it("uses authenticated userId for kaya-export upload", async () => {
      const { app, queue } = createTestApp();
      await request(app, "post", "/api/upload/kaya-export", {
        headers: { "Content-Type": "text/csv", "x-file-ext": ".csv" },
        body: Buffer.from("date,grade,gym\n2026-07-09,v3,Touchstone Pacific Pipe"),
      });
      expect(queue.add).toHaveBeenCalledWith(
        "kaya-export",
        expect.objectContaining({ userId: "user-1" }),
        undefined,
      );
    });
  });

  describe("POST /api/upload/apple-health", () => {
    it("rejects unsupported content type", async () => {
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/upload/apple-health", {
        headers: { "Content-Type": "text/html" },
        body: Buffer.from("test"),
      });
      expect(res.status).toBe(415);
    });

    it("accepts single file upload", async () => {
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/upload/apple-health", {
        headers: { "Content-Type": "application/zip" },
        body: Buffer.from("fake-zip-data"),
      });
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.status).toBe("processing");
      expect(data.jobId).toBeDefined();
    });

    it("returns 500 when upload fails", async () => {
      vi.mocked(streamToFile).mockRejectedValueOnce(new Error("disk full"));
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/upload/apple-health", {
        headers: { "Content-Type": "application/zip" },
        body: Buffer.from("data"),
      });
      expect(res.status).toBe(500);
    });
  });

  describe("GET /api/upload/apple-health/status/:jobId", () => {
    it("applies the upload status rate limiter", async () => {
      const { app, queue } = createTestApp();
      queue.getJob.mockResolvedValueOnce(null);

      const res = await request(app, "get", "/api/upload/apple-health/status/unknown");

      expect(res.headers.has("ratelimit")).toBe(true);
    });

    it("returns 404 for unknown job", async () => {
      const { app, queue } = createTestApp();
      queue.getJob.mockResolvedValueOnce(null);
      const res = await request(app, "get", "/api/upload/apple-health/status/unknown");
      expect(res.status).toBe(404);
    });

    it("returns job status", async () => {
      const { app, queue } = createTestApp();
      const mockJob = {
        data: { userId: "user-1" },
        getState: vi.fn(() => Promise.resolve("completed")),
        progress: 100,
        failedReason: null,
        returnvalue: { records: 5 },
      };
      queue.getJob.mockResolvedValueOnce(mockJob);
      const res = await request(app, "get", "/api/upload/apple-health/status/job-123");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.status).toBe("done");
    });

    it("returns 403 when job belongs to another user", async () => {
      const { app, queue } = createTestApp();
      const mockJob = {
        data: { userId: "user-2" },
        getState: vi.fn(() => Promise.resolve("active")),
        progress: 50,
        failedReason: null,
        returnvalue: null,
      };
      queue.getJob.mockResolvedValueOnce(mockJob);
      const res = await request(app, "get", "/api/upload/apple-health/status/job-other");
      expect(res.status).toBe(403);
    });
  });

  describe("POST /api/upload/strong-csv", () => {
    it("rejects unsupported content type", async () => {
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/upload/strong-csv", {
        headers: { "Content-Type": "application/json" },
        body: Buffer.from("{}"),
      });
      expect(res.status).toBe(415);
    });

    it("accepts CSV upload", async () => {
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/upload/strong-csv", {
        headers: { "Content-Type": "text/csv" },
        body: Buffer.from("date,exercise\n2026-01-01,squat"),
      });
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.status).toBe("processing");
    });

    it("passes weightUnit=lbs when units=lbs", async () => {
      const { app, queue } = createTestApp();
      await request(app, "post", "/api/upload/strong-csv?units=lbs", {
        headers: { "Content-Type": "text/csv" },
        body: Buffer.from("date,exercise\n2026-01-01,squat"),
      });
      expect(queue.add).toHaveBeenCalledWith(
        "strong-csv",
        expect.objectContaining({ weightUnit: "lbs" }),
        undefined,
      );
    });

    it("defaults weightUnit to kg when units not set", async () => {
      const { app, queue } = createTestApp();
      await request(app, "post", "/api/upload/strong-csv", {
        headers: { "Content-Type": "text/csv" },
        body: Buffer.from("date,exercise\n2026-01-01,squat"),
      });
      expect(queue.add).toHaveBeenCalledWith(
        "strong-csv",
        expect.objectContaining({ weightUnit: "kg" }),
        undefined,
      );
    });

    it("accepts chunked CSV uploads through the shared upload flow", async () => {
      const { app, queue } = createTestApp();

      const first = await request(app, "post", "/api/upload/strong-csv?units=lbs", {
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upload-id": "strong-chunked",
          "x-chunk-index": "0",
          "x-chunk-total": "2",
          "x-file-ext": ".csv",
        },
        body: Buffer.from("date,exercise\n"),
      });
      const second = await request(app, "post", "/api/upload/strong-csv?units=lbs", {
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upload-id": "strong-chunked",
          "x-chunk-index": "1",
          "x-chunk-total": "2",
          "x-file-ext": ".csv",
        },
        body: Buffer.from("2026-01-01,squat"),
      });

      expect(first.status).toBe(200);
      expect(JSON.parse(first.body)).toMatchObject({
        status: "uploading",
        jobId: "strong-chunked",
      });
      expect(second.status).toBe(200);
      expect(JSON.parse(second.body)).toMatchObject({
        status: "processing",
        jobId: "strong-chunked",
      });
      await vi.waitFor(() => {
        expect(queue.add).toHaveBeenCalledWith(
          "strong-csv",
          expect.objectContaining({
            importType: "strong-csv",
            userId: "user-1",
            weightUnit: "lbs",
          }),
          { jobId: "strong-chunked" },
        );
      });
      expect(assembleChunks).toHaveBeenCalledWith(
        expect.not.stringContaining("strong-chunked"),
        expect.not.stringContaining("strong-chunked"),
      );
    });
  });

  describe("POST /api/upload/apple-health (chunked)", () => {
    it("rejects invalid upload ID", async () => {
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/upload/apple-health", {
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upload-id": "../../etc/passwd",
          "x-chunk-index": "0",
          "x-chunk-total": "3",
        },
        body: Buffer.from("chunk-data"),
      });
      expect(res.status).toBe(400);
      expect(res.body).toContain("Invalid upload ID");
    });

    it("rejects invalid file extension", async () => {
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/upload/apple-health", {
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upload-id": "upload-123",
          "x-chunk-index": "0",
          "x-chunk-total": "3",
          "x-file-ext": ".exe",
        },
        body: Buffer.from("chunk-data"),
      });
      expect(res.status).toBe(400);
      expect(res.body).toContain("Invalid file extension");
    });

    it("accepts first chunk and returns uploading status", async () => {
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/upload/apple-health", {
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upload-id": "upload-abc",
          "x-chunk-index": "0",
          "x-chunk-total": "3",
        },
        body: Buffer.from("chunk-0"),
      });
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.status).toBe("uploading");
      expect(data.received).toBe(1);
      expect(data.total).toBe(3);
    });

    it("shares upload status across app instances", async () => {
      const first = createTestApp();
      const second = createTestApp();

      await request(first.app, "post", "/api/upload/apple-health", {
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upload-id": "status-job",
          "x-chunk-index": "0",
          "x-chunk-total": "3",
        },
        body: Buffer.from("chunk-0"),
      });

      const res = await request(second.app, "get", "/api/upload/apple-health/status/status-job");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.status).toBe("uploading");
      expect(data.progress).toBeGreaterThan(0);
    });

    it("keeps .xml extension when single-chunk upload falls back to non-chunked", async () => {
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/upload/apple-health", {
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upload-id": "single-xml-upload",
          "x-chunk-index": "0",
          "x-chunk-total": "1",
          "x-file-ext": ".xml",
        },
        body: Buffer.from("<HealthData></HealthData>"),
      });

      expect(res.status).toBe(200);
      const filePath = vi.mocked(streamToFile).mock.calls[0][1];
      expect(filePath.endsWith(".xml")).toBe(true);
    });
  });

  describe("GET /api/upload/apple-health/status (job states)", () => {
    it("returns failed status for failed job", async () => {
      const { app, queue } = createTestApp();
      const mockJob = {
        data: { userId: "user-1" },
        getState: vi.fn(() => Promise.resolve("failed")),
        progress: 0,
        failedReason: "Out of memory",
        returnvalue: null,
      };
      queue.getJob.mockResolvedValueOnce(mockJob);
      const res = await request(app, "get", "/api/upload/apple-health/status/failed-job");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.status).toBe("error");
      expect(data.message).toBe("Out of memory");
    });

    it("returns processing status for active job", async () => {
      const { app, queue } = createTestApp();
      const mockJob = {
        data: { userId: "user-1" },
        getState: vi.fn(() => Promise.resolve("active")),
        progress: { percentage: 50, message: "Parsing records..." },
        failedReason: null,
        returnvalue: null,
      };
      queue.getJob.mockResolvedValueOnce(mockJob);
      const res = await request(app, "get", "/api/upload/apple-health/status/active-job");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.status).toBe("processing");
      expect(data.progress).toBe(50);
      expect(data.message).toBe("Parsing records...");
    });

    it("handles numeric progress", async () => {
      const { app, queue } = createTestApp();
      const mockJob = {
        data: { userId: "user-1" },
        getState: vi.fn(() => Promise.resolve("active")),
        progress: 75,
        failedReason: null,
        returnvalue: null,
      };
      queue.getJob.mockResolvedValueOnce(mockJob);
      const res = await request(app, "get", "/api/upload/apple-health/status/num-progress");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.progress).toBe(75);
    });

    it("handles undefined progress", async () => {
      const { app, queue } = createTestApp();
      const mockJob = {
        data: { userId: "user-1" },
        getState: vi.fn(() => Promise.resolve("waiting")),
        progress: null,
        failedReason: null,
        returnvalue: null,
      };
      queue.getJob.mockResolvedValueOnce(mockJob);
      const res = await request(app, "get", "/api/upload/apple-health/status/no-progress");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.progress).toBe(0);
    });

    it("returns failedCount when progress includes it", async () => {
      const { app, queue } = createTestApp();
      const mockJob = {
        data: { userId: "user-1" },
        getState: vi.fn(() => Promise.resolve("active")),
        progress: {
          percentage: 46,
          message: "356 of 15774 complete, 15418 failed",
          failedCount: 15418,
        },
        failedReason: null,
        returnvalue: null,
      };
      queue.getJob.mockResolvedValueOnce(mockJob);
      const res = await request(app, "get", "/api/upload/apple-health/status/failed-count");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.failedCount).toBe(15418);
    });

    it("omits failedCount when progress does not include it", async () => {
      const { app, queue } = createTestApp();
      const mockJob = {
        data: { userId: "user-1" },
        getState: vi.fn(() => Promise.resolve("active")),
        progress: { percentage: 50, message: "Processing..." },
        failedReason: null,
        returnvalue: null,
      };
      queue.getJob.mockResolvedValueOnce(mockJob);
      const res = await request(app, "get", "/api/upload/apple-health/status/no-failed-count");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.failedCount).toBeUndefined();
    });

    it("handles Redis unavailability gracefully", async () => {
      const { app, queue } = createTestApp();
      queue.getJob.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      const res = await request(app, "get", "/api/upload/apple-health/status/redis-down");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/upload/strong-csv/status/:jobId", () => {
    it("applies the upload status rate limiter", async () => {
      const { app, queue } = createTestApp();
      queue.getJob.mockResolvedValueOnce(null);

      const res = await request(app, "get", "/api/upload/strong-csv/status/unknown");

      expect(res.headers.has("ratelimit")).toBe(true);
    });

    it("returns 404 for unknown job", async () => {
      const { app, queue } = createTestApp();
      queue.getJob.mockResolvedValueOnce(null);
      const res = await request(app, "get", "/api/upload/strong-csv/status/unknown");
      expect(res.status).toBe(404);
    });

    it("returns job status for known job", async () => {
      const { app, queue } = createTestApp();
      const mockJob = {
        data: { userId: "user-1" },
        getState: vi.fn(() => Promise.resolve("completed")),
        progress: 100,
        failedReason: null,
        returnvalue: { records: 10 },
      };
      queue.getJob.mockResolvedValueOnce(mockJob);
      const res = await request(app, "get", "/api/upload/strong-csv/status/job-456");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.status).toBe("done");
    });

    it("returns 403 when job belongs to another user", async () => {
      const { app, queue } = createTestApp();
      const mockJob = {
        data: { userId: "user-2" },
        getState: vi.fn(() => Promise.resolve("active")),
        progress: 50,
        failedReason: null,
        returnvalue: null,
      };
      queue.getJob.mockResolvedValueOnce(mockJob);
      const res = await request(app, "get", "/api/upload/strong-csv/status/job-other");
      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/upload/cronometer-csv/status/:jobId", () => {
    it("applies the upload status rate limiter", async () => {
      const { app, queue } = createTestApp();
      queue.getJob.mockResolvedValueOnce(null);

      const res = await request(app, "get", "/api/upload/cronometer-csv/status/unknown");

      expect(res.headers.has("ratelimit")).toBe(true);
    });

    it("returns 404 for unknown job", async () => {
      const { app, queue } = createTestApp();
      queue.getJob.mockResolvedValueOnce(null);
      const res = await request(app, "get", "/api/upload/cronometer-csv/status/unknown");
      expect(res.status).toBe(404);
    });

    it("returns 403 when job belongs to another user", async () => {
      const { app, queue } = createTestApp();
      const mockJob = {
        data: { userId: "user-2" },
        getState: vi.fn(() => Promise.resolve("active")),
        progress: 50,
        failedReason: null,
        returnvalue: null,
      };
      queue.getJob.mockResolvedValueOnce(mockJob);
      const res = await request(app, "get", "/api/upload/cronometer-csv/status/job-other");
      expect(res.status).toBe(403);
    });
  });

  describe("POST /api/upload/cronometer-csv", () => {
    it("rejects unsupported content type", async () => {
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/upload/cronometer-csv", {
        headers: { "Content-Type": "application/json" },
        body: Buffer.from("{}"),
      });
      expect(res.status).toBe(415);
    });

    it("accepts CSV upload", async () => {
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/upload/cronometer-csv", {
        headers: { "Content-Type": "text/csv" },
        body: Buffer.from("date,food\n2026-01-01,banana"),
      });
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.status).toBe("processing");
    });

    it("returns 500 when upload fails", async () => {
      vi.mocked(streamToFile).mockRejectedValueOnce(new Error("disk full"));
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/upload/cronometer-csv", {
        headers: { "Content-Type": "text/csv" },
        body: Buffer.from("data"),
      });
      expect(res.status).toBe(500);
    });
  });

  describe("POST /api/upload/kaya-export", () => {
    it("rejects unsupported content type with Kaya-specific guidance", async () => {
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/upload/kaya-export", {
        headers: { "Content-Type": "application/json", "x-file-ext": ".csv" },
        body: Buffer.from("{}"),
      });
      expect(res.status).toBe(415);
      expect(res.body).toContain("Kaya imports require a CSV export");
    });

    it("rejects non-CSV file extensions with Kaya-specific guidance", async () => {
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/upload/kaya-export", {
        headers: { "Content-Type": "text/csv", "x-file-ext": ".json" },
        body: Buffer.from("data"),
      });
      expect(res.status).toBe(400);
      expect(res.body).toContain("Kaya imports require a CSV export");
    });

    it("accepts CSV upload", async () => {
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/upload/kaya-export", {
        headers: { "Content-Type": "text/csv", "x-file-ext": ".csv" },
        body: Buffer.from("date,grade,gym\n2026-07-09,v3,Touchstone Pacific Pipe"),
      });
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.status).toBe("processing");
    });

    it("accepts CSV upload with content type parameters", async () => {
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/upload/kaya-export", {
        headers: { "Content-Type": "text/csv ; charset=utf-8", "x-file-ext": ".csv" },
        body: Buffer.from("date,grade,gym\n2026-07-09,v3,Touchstone Pacific Pipe"),
      });

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ status: "processing", jobId: "job-123" });
    });

    it("accepts CSV upload when optional content type and extension headers are absent", async () => {
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/upload/kaya-export", {
        body: Buffer.from("date,grade,gym\n2026-07-09,v3,Touchstone Pacific Pipe"),
      });

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ status: "processing", jobId: "job-123" });
    });

    it("returns 500 and cleans up when Kaya upload fails", async () => {
      vi.mocked(streamToFile).mockRejectedValueOnce(new Error("disk full"));
      mockUnlink.mockRejectedValueOnce(new Error("ENOENT"));
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/upload/kaya-export", {
        headers: { "Content-Type": "text/csv", "x-file-ext": ".csv" },
        body: Buffer.from("data"),
      });

      expect(res.status).toBe(500);
      expect(res.body).toContain("Upload failed");
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("[kaya-export]"));
      expect(logger.warn).toHaveBeenCalledWith(
        "Failed to clean up tmp file %s: %s",
        expect.stringContaining("kaya-export-"),
        expect.any(Error),
      );
    });
  });

  describe("GET /api/upload/kaya-export/status/:jobId", () => {
    it("returns 404 for unknown job", async () => {
      const { app, queue } = createTestApp();
      queue.getJob.mockResolvedValueOnce(null);
      const res = await request(app, "get", "/api/upload/kaya-export/status/unknown");
      expect(res.status).toBe(404);
      expect(res.body).toContain("Unknown job");
    });

    it("returns job status only for the authenticated user", async () => {
      const { app, queue } = createTestApp();
      const mockJob = {
        data: { userId: "user-1" },
        getState: vi.fn(() => Promise.resolve("completed")),
        progress: 100,
        failedReason: null,
        returnvalue: { records: 4 },
      };
      queue.getJob.mockResolvedValueOnce(mockJob);

      const res = await request(app, "get", "/api/upload/kaya-export/status/job-kaya");

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).status).toBe("done");
    });

    it("returns 403 when job belongs to another user", async () => {
      const { app, queue } = createTestApp();
      const mockJob = {
        data: { userId: "user-2" },
        getState: vi.fn(() => Promise.resolve("active")),
        progress: 50,
        failedReason: null,
        returnvalue: null,
      };
      queue.getJob.mockResolvedValueOnce(mockJob);
      const res = await request(app, "get", "/api/upload/kaya-export/status/job-other");
      expect(res.status).toBe(403);
      expect(res.body).toContain("Forbidden");
    });
  });

  describe("GET /api/upload/zos-app/status/:jobId", () => {
    it("applies the upload status rate limiter", async () => {
      const { app, queue } = createTestApp();
      queue.getJob.mockResolvedValueOnce(null);

      const res = await request(app, "get", "/api/upload/zos-app/status/unknown");

      expect(res.headers.has("ratelimit")).toBe(true);
    });
  });

  describe("POST /api/upload/strong-csv (error)", () => {
    it("returns 500 when upload fails", async () => {
      vi.mocked(streamToFile).mockRejectedValueOnce(new Error("disk full"));
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/upload/strong-csv", {
        headers: { "Content-Type": "text/csv" },
        body: Buffer.from("data"),
      });
      expect(res.status).toBe(500);
    });
  });

  describe("POST /api/upload/apple-health (chunked - all chunks)", () => {
    it("responds with processing status after enqueue when all chunks are received", async () => {
      const { app } = createTestApp();

      // Send chunk 0 of 2
      await request(app, "post", "/api/upload/apple-health", {
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upload-id": "upload-full",
          "x-chunk-index": "0",
          "x-chunk-total": "2",
        },
        body: Buffer.from("chunk-0"),
      });

      // Send chunk 1 of 2 (final) — should enqueue before returning the job ID
      const res = await request(app, "post", "/api/upload/apple-health", {
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upload-id": "upload-full",
          "x-chunk-index": "1",
          "x-chunk-total": "2",
        },
        body: Buffer.from("chunk-1"),
      });

      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.status).toBe("processing");
      expect(data.jobId).toBe("upload-full");
    });

    it("handles chunked upload error", async () => {
      vi.mocked(streamToFile).mockRejectedValueOnce(new Error("write error"));
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/upload/apple-health", {
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upload-id": "upload-err",
          "x-chunk-index": "0",
          "x-chunk-total": "2",
        },
        body: Buffer.from("chunk-0"),
      });
      expect(res.status).toBe(500);
    });

    it("warns when rm fails during chunked upload error cleanup", async () => {
      const { app } = createTestApp();
      // First chunk succeeds to create the upload entry
      await request(app, "post", "/api/upload/apple-health", {
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upload-id": "upload-rm-err",
          "x-chunk-index": "0",
          "x-chunk-total": "2",
        },
        body: Buffer.from("chunk-0"),
      });

      // Second chunk fails to trigger the outer catch, and rm rejects
      vi.mocked(streamToFile).mockRejectedValueOnce(new Error("write error"));
      mockRm.mockRejectedValueOnce(new Error("EPERM"));

      const res = await request(app, "post", "/api/upload/apple-health", {
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upload-id": "upload-rm-err",
          "x-chunk-index": "1",
          "x-chunk-total": "2",
        },
        body: Buffer.from("chunk-1"),
      });
      expect(res.status).toBe(500);

      await vi.waitFor(() => {
        expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
          "Failed to clean up upload dir %s: %s",
          expect.any(String),
          expect.any(Error),
        );
      });
    });

    it("warns when rm fails during assembly error cleanup", async () => {
      vi.mocked(assembleChunks).mockRejectedValueOnce(new Error("disk full"));
      mockRm.mockRejectedValueOnce(new Error("EPERM"));
      const { app } = createTestApp();

      // Send chunk 0 of 2
      await request(app, "post", "/api/upload/apple-health", {
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upload-id": "upload-rm-assembly-err",
          "x-chunk-index": "0",
          "x-chunk-total": "2",
        },
        body: Buffer.from("chunk-0"),
      });

      // Send chunk 1 of 2 (final)
      await request(app, "post", "/api/upload/apple-health", {
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upload-id": "upload-rm-assembly-err",
          "x-chunk-index": "1",
          "x-chunk-total": "2",
        },
        body: Buffer.from("chunk-1"),
      });

      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        "Failed to clean up chunk dir %s: %s",
        expect.any(String),
        expect.any(Error),
      );
    });

    it("warns when rm fails during stale upload cleanup", async () => {
      vi.useFakeTimers();
      const { app } = createTestApp();

      // Send first chunk to create the upload entry
      await request(app, "post", "/api/upload/apple-health", {
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upload-id": "upload-stale-rm-err",
          "x-chunk-index": "0",
          "x-chunk-total": "3",
        },
        body: Buffer.from("chunk-0"),
      });

      // Make rm reject when the stale timeout fires
      mockRm.mockRejectedValueOnce(new Error("EPERM"));

      // Advance past the 30-minute upload-session timeout, then poll status.
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1);
      await request(app, "get", "/api/upload/apple-health/status/upload-stale-rm-err");

      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        "Failed to clean up stale upload dir %s: %s",
        expect.any(String),
        expect.any(Error),
      );

      vi.useRealTimers();
    });

    it("sets error status when assembly fails", async () => {
      vi.mocked(assembleChunks).mockRejectedValueOnce(new Error("disk full"));
      const { app } = createTestApp();

      // Send chunk 0 of 2
      await request(app, "post", "/api/upload/apple-health", {
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upload-id": "upload-assembly-err",
          "x-chunk-index": "0",
          "x-chunk-total": "2",
        },
        body: Buffer.from("chunk-0"),
      });

      // Send chunk 1 of 2 (final)
      const res = await request(app, "post", "/api/upload/apple-health", {
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upload-id": "upload-assembly-err",
          "x-chunk-index": "1",
          "x-chunk-total": "2",
        },
        body: Buffer.from("chunk-1"),
      });

      expect(res.status).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ error: "Failed to assemble uploaded file" });

      // Verify error status is set — poll the status endpoint
      const statusRes = await request(
        app,
        "get",
        "/api/upload/apple-health/status/upload-assembly-err",
      );
      expect(statusRes.status).toBe(200);
      const statusData = JSON.parse(statusRes.body);
      expect(statusData.status).toBe("error");
      expect(statusData.message).toBe("Failed to assemble uploaded file");
    });

    it("uses upload ID as BullMQ job ID for seamless polling", async () => {
      const { app, queue } = createTestApp();

      await request(app, "post", "/api/upload/apple-health", {
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upload-id": "upload-jobid-test",
          "x-chunk-index": "0",
          "x-chunk-total": "2",
        },
        body: Buffer.from("chunk-0"),
      });

      await request(app, "post", "/api/upload/apple-health", {
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upload-id": "upload-jobid-test",
          "x-chunk-index": "1",
          "x-chunk-total": "2",
        },
        body: Buffer.from("chunk-1"),
      });

      expect(queue.add).toHaveBeenCalledWith(
        "apple-health",
        expect.objectContaining({ importType: "apple-health" }),
        { jobId: "upload-jobid-test" },
      );
    });
  });

  describe("files are written to JOB_FILES_DIR", () => {
    it("writes single Apple Health upload to JOB_FILES_DIR", async () => {
      const { app } = createTestApp();
      await request(app, "post", "/api/upload/apple-health", {
        headers: { "Content-Type": "application/zip" },
        body: Buffer.from("fake-zip"),
      });
      const filePath = vi.mocked(streamToFile).mock.calls[0][1];
      expect(filePath.startsWith(EXPECTED_JOB_FILES_DIR)).toBe(true);
      expect(filePath).toContain("apple-health-");
    });

    it("writes chunked Apple Health upload to JOB_FILES_DIR", async () => {
      const { app } = createTestApp();
      await request(app, "post", "/api/upload/apple-health", {
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upload-id": "upload-dir-test",
          "x-chunk-index": "0",
          "x-chunk-total": "2",
        },
        body: Buffer.from("chunk-0"),
      });
      const chunkPath = vi.mocked(streamToFile).mock.calls[0][1];
      expect(chunkPath.startsWith(EXPECTED_JOB_FILES_DIR)).toBe(true);
    });

    it("assembles chunked file into JOB_FILES_DIR", async () => {
      const { app } = createTestApp();
      // Send both chunks
      await request(app, "post", "/api/upload/apple-health", {
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upload-id": "upload-assemble-dir",
          "x-chunk-index": "0",
          "x-chunk-total": "2",
        },
        body: Buffer.from("chunk-0"),
      });
      await request(app, "post", "/api/upload/apple-health", {
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upload-id": "upload-assemble-dir",
          "x-chunk-index": "1",
          "x-chunk-total": "2",
        },
        body: Buffer.from("chunk-1"),
      });
      const assembledPath = vi.mocked(assembleChunks).mock.calls[0][1];
      expect(assembledPath.startsWith(EXPECTED_JOB_FILES_DIR)).toBe(true);
      expect(assembledPath).toContain("apple-health-");
      expect(assembledPath).not.toContain("upload-assemble-dir");
    });

    it("writes Strong CSV upload to JOB_FILES_DIR", async () => {
      const { app } = createTestApp();
      await request(app, "post", "/api/upload/strong-csv", {
        headers: { "Content-Type": "text/csv" },
        body: Buffer.from("date,exercise\n2026-01-01,squat"),
      });
      const filePath = vi.mocked(streamToFile).mock.calls[0][1];
      expect(filePath.startsWith(EXPECTED_JOB_FILES_DIR)).toBe(true);
      expect(filePath).toContain("strong-csv-");
    });

    it("writes Cronometer CSV upload to JOB_FILES_DIR", async () => {
      const { app } = createTestApp();
      await request(app, "post", "/api/upload/cronometer-csv", {
        headers: { "Content-Type": "text/csv" },
        body: Buffer.from("date,food\n2026-01-01,banana"),
      });
      const filePath = vi.mocked(streamToFile).mock.calls[0][1];
      expect(filePath.startsWith(EXPECTED_JOB_FILES_DIR)).toBe(true);
      expect(filePath).toContain("cronometer-csv-");
    });

    it("writes Kaya export upload to JOB_FILES_DIR", async () => {
      const { app } = createTestApp();
      await request(app, "post", "/api/upload/kaya-export", {
        headers: { "Content-Type": "text/csv", "x-file-ext": ".csv" },
        body: Buffer.from("date,grade,gym\n2026-07-09,v3,Touchstone Pacific Pipe"),
      });
      const filePath = vi.mocked(streamToFile).mock.calls[0][1];
      expect(filePath.startsWith(EXPECTED_JOB_FILES_DIR)).toBe(true);
      expect(filePath).toContain("kaya-export-");
    });
  });

  describe("POST /api/upload/apple-health (XML content type)", () => {
    it("accepts XML content type for single file", async () => {
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/upload/apple-health", {
        headers: { "Content-Type": "application/xml" },
        body: Buffer.from("<HealthData></HealthData>"),
      });
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.status).toBe("processing");
    });

    it("passes since=epoch when fullSync=true", async () => {
      const { app, queue } = createTestApp();
      const res = await request(app, "post", "/api/upload/apple-health?fullSync=true", {
        headers: { "Content-Type": "application/zip" },
        body: Buffer.from("data"),
      });
      expect(res.status).toBe(200);
      expect(queue.add).toHaveBeenCalledWith(
        "apple-health",
        expect.objectContaining({ since: "1970-01-01T00:00:00.000Z" }),
        undefined,
      );
    });

    it("passes since=7 days ago when fullSync is not set", async () => {
      const { app, queue } = createTestApp();
      const before = Date.now();
      const res = await request(app, "post", "/api/upload/apple-health", {
        headers: { "Content-Type": "application/zip" },
        body: Buffer.from("data"),
      });
      expect(res.status).toBe(200);
      const sinceArg = String(queue.add.mock.calls[0][1].since);
      const sinceMs = new Date(sinceArg).getTime();
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      // since should be approximately 7 days before the request
      expect(sinceMs).toBeGreaterThan(before - sevenDaysMs - 5000);
      expect(sinceMs).toBeLessThan(before - sevenDaysMs + 5000);
    });
  });

  describe("POST /api/upload/garmin-dump", () => {
    it("queues the import without orchestrating a worker container", async () => {
      const { app, queue } = createTestApp();
      const res = await request(app, "post", "/api/upload/garmin-dump", {
        headers: { "Content-Type": "application/zip" },
        body: Buffer.from("zip-data"),
      });

      expect(res.status).toBe(200);
      expect(queue.add).toHaveBeenCalledOnce();
    });

    it("accepts zip upload with a bounded stream size", async () => {
      const { app, queue } = createTestApp();
      const res = await request(app, "post", "/api/upload/garmin-dump", {
        headers: { "Content-Type": "application/zip" },
        body: Buffer.from("zip-data"),
      });

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ status: "processing", jobId: "job-123" });
      expect(streamToFile).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("garmin-dump-"),
        2 * 1024 * 1024 * 1024,
      );
      expect(vi.mocked(streamToFile).mock.calls[0][1]).toMatch(/garmin-dump-[a-f0-9-]+\.zip$/);
      expect(queue.add).toHaveBeenCalledWith(
        "garmin-dump",
        expect.objectContaining({ importType: "garmin-dump", userId: "user-1" }),
        undefined,
      );
    });

    it("accepts zip content type with parameters and mixed case", async () => {
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/upload/garmin-dump", {
        headers: { "Content-Type": "APPLICATION/ZIP ; charset=binary" },
        body: Buffer.from("zip-data"),
      });

      expect(res.status).toBe(200);
      expect(streamToFile).toHaveBeenCalled();
    });

    it("accepts uploads without a content type", async () => {
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/upload/garmin-dump", {
        body: Buffer.from("zip-data"),
      });

      expect(res.status).toBe(200);
      expect(streamToFile).toHaveBeenCalled();
    });

    it("accepts uploads without content length", async () => {
      const { app } = createTestApp();
      const res = await rawRequest(app, "POST", "/api/upload/garmin-dump", {
        headers: { "Content-Type": "application/zip" },
        body: Buffer.from("zip-data"),
      });

      expect(res.status).toBe(200);
      expect(streamToFile).toHaveBeenCalled();
    });

    it("rejects unsupported content type before streaming", async () => {
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/upload/garmin-dump", {
        headers: { "Content-Type": "text/plain" },
        body: Buffer.from("not-zip"),
      });

      expect(res.status).toBe(415);
      expect(JSON.parse(res.body)).toEqual({
        error: "Unsupported Content-Type. Expected application/zip or application/octet-stream",
      });
      expect(streamToFile).not.toHaveBeenCalled();
    });

    it("rejects content length above the Garmin dump limit before streaming", async () => {
      const { app } = createTestApp();
      const res = await rawRequest(app, "POST", "/api/upload/garmin-dump", {
        headers: {
          "Content-Type": "application/zip",
          "Content-Length": String(2 * 1024 * 1024 * 1024 + 1),
        },
      });

      expect(res.status).toBe(413);
      expect(JSON.parse(res.body)).toEqual({
        error: "Garmin dump upload exceeds maximum size of 2147483648 bytes",
      });
      expect(streamToFile).not.toHaveBeenCalled();
    });

    it("allows content length exactly at the Garmin dump limit", async () => {
      const { app } = createTestApp();
      const res = await rawRequest(app, "POST", "/api/upload/garmin-dump", {
        headers: {
          "Content-Type": "application/zip",
          "Content-Length": String(2 * 1024 * 1024 * 1024),
        },
      });

      expect(res.status).toBe(200);
      expect(streamToFile).toHaveBeenCalled();
    });

    it("accepts chunked ZIP uploads through the shared upload flow", async () => {
      const { app, queue } = createTestApp();

      await request(app, "post", "/api/upload/garmin-dump", {
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upload-id": "garmin-chunked",
          "x-chunk-index": "0",
          "x-chunk-total": "2",
          "x-file-ext": ".zip",
        },
        body: Buffer.from("PK-1"),
      });
      const res = await request(app, "post", "/api/upload/garmin-dump", {
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upload-id": "garmin-chunked",
          "x-chunk-index": "1",
          "x-chunk-total": "2",
          "x-file-ext": ".zip",
        },
        body: Buffer.from("PK-2"),
      });

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        status: "processing",
        jobId: "garmin-chunked",
      });
      await vi.waitFor(() => {
        expect(queue.add).toHaveBeenCalledWith(
          "garmin-dump",
          expect.objectContaining({ importType: "garmin-dump", userId: "user-1" }),
          { jobId: "garmin-chunked" },
        );
      });
      expect(assembleChunks).toHaveBeenCalledWith(
        expect.not.stringContaining("garmin-chunked"),
        expect.not.stringContaining("garmin-chunked"),
      );
    });

    it("rejects chunked uploads that exceed the route total size limit", async () => {
      const { app, queue } = createTestApp();
      const garminLimitBytes = 2 * 1024 * 1024 * 1024;
      vi.mocked(streamToFile).mockResolvedValueOnce(garminLimitBytes).mockResolvedValueOnce(1);

      const first = await request(app, "post", "/api/upload/garmin-dump", {
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upload-id": "garmin-too-large",
          "x-chunk-index": "0",
          "x-chunk-total": "2",
          "x-file-ext": ".zip",
        },
        body: Buffer.from("PK-1"),
      });
      const second = await request(app, "post", "/api/upload/garmin-dump", {
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upload-id": "garmin-too-large",
          "x-chunk-index": "1",
          "x-chunk-total": "2",
          "x-file-ext": ".zip",
        },
        body: Buffer.from("PK-2"),
      });

      expect(first.status).toBe(200);
      expect(second.status).toBe(413);
      expect(JSON.parse(second.body)).toEqual({ error: "Upload exceeds maximum size" });
      expect(queue.add).not.toHaveBeenCalled();
      expect(mockRm).toHaveBeenCalledWith(expect.not.stringContaining("garmin-too-large"), {
        recursive: true,
        force: true,
      });
    });

    it("rejects chunked uploads with too many chunks", async () => {
      const { app } = createTestApp();

      const res = await request(app, "post", "/api/upload/garmin-dump", {
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upload-id": "garmin-too-many-chunks",
          "x-chunk-index": "0",
          "x-chunk-total": "1001",
          "x-file-ext": ".zip",
        },
        body: Buffer.from("PK-1"),
      });

      expect(res.status).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: "Invalid chunk headers" });
      expect(streamToFile).not.toHaveBeenCalled();
    });

    it("cleans up the temp file and returns upload failure when streaming fails", async () => {
      vi.mocked(streamToFile).mockRejectedValueOnce(new Error("disk full"));
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/upload/garmin-dump", {
        headers: { "Content-Type": "application/zip" },
        body: Buffer.from("zip-data"),
      });

      expect(res.status).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ error: "Upload failed" });
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("[garmin-dump] Upload failed: Error: disk full"),
      );
      expect(mockUnlink).toHaveBeenCalledWith(vi.mocked(streamToFile).mock.calls[0][1]);
    });
  });

  describe("POST /api/upload/fit-file", () => {
    it("enqueues a FIT import through the standard import lifecycle", async () => {
      const { app, queue } = createTestApp();
      const res = await request(app, "post", "/api/upload/fit-file", {
        headers: { "Content-Type": "application/octet-stream" },
        body: Buffer.from("fit-data"),
      });

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ status: "processing", jobId: "job-123" });
      expect(queue.add).toHaveBeenCalledWith(
        "fit-file",
        expect.objectContaining({
          filePath: expect.stringMatching(/fit-file-[a-f0-9-]+\.fit$/),
          since: "1970-01-01T00:00:00.000Z",
          userId: "user-1",
          importType: "fit-file",
        }),
        undefined,
      );
    });

    it("rejects non-FIT file extensions", async () => {
      const { app, queue } = createTestApp();
      const res = await request(app, "post", "/api/upload/fit-file", {
        headers: {
          "Content-Type": "application/octet-stream",
          "x-file-ext": ".zip",
        },
        body: Buffer.from("zip-data"),
      });

      expect(res.status).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: "FIT imports require a .fit file" });
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("reads import status from the standard import queue", async () => {
      const { app, queue } = createTestApp();
      queue.getJob.mockResolvedValue({
        id: "fit-job",
        getState: vi.fn().mockResolvedValue("completed"),
        progress: { percentage: 100, message: "FIT file import complete." },
        failedReason: null,
        returnvalue: { recordsSynced: 1, errors: [] },
        data: { userId: "user-1" },
      });

      const res = await request(app, "get", "/api/upload/fit-file/status/fit-job");

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ status: "done", progress: 100 });
      expect(queue.getJob).toHaveBeenCalledWith("fit-job");
    });
  });

  describe("GET /api/upload/garmin-dump/status/:jobId", () => {
    it("returns 404 for unknown job", async () => {
      const { app, queue } = createTestApp();
      queue.getJob.mockResolvedValueOnce(null);

      const res = await request(app, "get", "/api/upload/garmin-dump/status/unknown");

      expect(res.status).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: "Unknown job" });
    });

    it("returns job status for the authenticated user", async () => {
      const { app, queue } = createTestApp();
      queue.getJob.mockResolvedValueOnce({
        data: { userId: "user-1" },
        getState: vi.fn(() => Promise.resolve("completed")),
        progress: 100,
        failedReason: null,
        returnvalue: { records: 3 },
      });

      const res = await request(app, "get", "/api/upload/garmin-dump/status/job-garmin");

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        status: "done",
        progress: 100,
        result: { records: 3 },
        userId: "user-1",
      });
    });

    it("returns 403 when the job belongs to another user", async () => {
      const { app, queue } = createTestApp();
      queue.getJob.mockResolvedValueOnce({
        data: { userId: "user-2" },
        getState: vi.fn(() => Promise.resolve("active")),
        progress: 50,
        failedReason: null,
        returnvalue: null,
      });

      const res = await request(app, "get", "/api/upload/garmin-dump/status/job-other");

      expect(res.status).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: "Forbidden" });
    });
  });
});
