import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/server-utils.ts", () => ({
  streamToFile: vi.fn(() => Promise.resolve()),
  assembleChunks: vi.fn(() => Promise.resolve()),
}));

vi.mock("../lib/start-worker.ts", () => ({
  startWorker: vi.fn(),
}));

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

import type { AddressInfo } from "node:net";
import express from "express";
import { streamToFile } from "../lib/server-utils.ts";
import { createUploadRouter } from "./upload.ts";

function mockQueue() {
  const mockJob = {
    id: "job-123",
    getState: vi.fn(),
    progress: 0,
    failedReason: null,
    returnvalue: null,
  };
  return {
    add: vi.fn(() => Promise.resolve(mockJob)),
    getJob: vi.fn(() => Promise.resolve(mockJob)),
  };
}

function createTestApp() {
  const queue = mockQueue();
  const app = express();
  app.use("/api/upload", createUploadRouter({ getImportQueue: () => queue }));
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
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = getPort(server);
      const fetchOpts: RequestInit = {
        method: method.toUpperCase(),
        headers: opts?.headers,
        body: opts?.body,
      };
      fetch(`http://localhost:${port}${path}`, fetchOpts)
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

describe("createUploadRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    it("returns 404 for unknown job", async () => {
      const { app, queue } = createTestApp();
      queue.getJob.mockResolvedValueOnce(null);
      const res = await request(app, "get", "/api/upload/apple-health/status/unknown");
      expect(res.status).toBe(404);
    });

    it("returns job status", async () => {
      const { app, queue } = createTestApp();
      const mockJob = {
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
  });

  describe("GET /api/upload/apple-health/status (job states)", () => {
    it("returns failed status for failed job", async () => {
      const { app, queue } = createTestApp();
      const mockJob = {
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
        getState: vi.fn(() => Promise.resolve("active")),
        progress: { pct: 50, message: "Parsing records..." },
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

    it("handles Redis unavailability gracefully", async () => {
      const { app, queue } = createTestApp();
      queue.getJob.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      const res = await request(app, "get", "/api/upload/apple-health/status/redis-down");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/upload/strong-csv/status/:jobId", () => {
    it("returns 404 for unknown job", async () => {
      const { app, queue } = createTestApp();
      queue.getJob.mockResolvedValueOnce(null);
      const res = await request(app, "get", "/api/upload/strong-csv/status/unknown");
      expect(res.status).toBe(404);
    });

    it("returns job status for known job", async () => {
      const { app, queue } = createTestApp();
      const mockJob = {
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
  });

  describe("GET /api/upload/cronometer-csv/status/:jobId", () => {
    it("returns 404 for unknown job", async () => {
      const { app, queue } = createTestApp();
      queue.getJob.mockResolvedValueOnce(null);
      const res = await request(app, "get", "/api/upload/cronometer-csv/status/unknown");
      expect(res.status).toBe(404);
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
    it("assembles file when all chunks received", async () => {
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

      // Send chunk 1 of 2 (final)
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

    it("uses fullSync when query param is set", async () => {
      const { app } = createTestApp();
      const res = await request(app, "post", "/api/upload/apple-health?fullSync=true", {
        headers: { "Content-Type": "application/zip" },
        body: Buffer.from("data"),
      });
      expect(res.status).toBe(200);
    });
  });
});
