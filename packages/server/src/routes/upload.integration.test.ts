import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImportJobData } from "dofek/jobs/queues";
import express from "express";
import { afterAll, describe, expect, it, vi } from "vitest";

// Use a unique temp directory for each test run so parallel runs don't collide.
const TEST_JOB_DIR = join(tmpdir(), `upload-integ-${process.pid}-${Date.now()}`);
const ORIGINAL_JOB_FILES_DIR = process.env.JOB_FILES_DIR;
process.env.JOB_FILES_DIR = TEST_JOB_DIR;

// Dynamic import: upload.ts reads JOB_FILES_DIR at module scope, so it must
// be imported AFTER the env var is set.  Vitest hoists static `import` above
// any runtime assignment, hence the top-level `await import(…)`.
const { createUploadRouter } = await import("./upload.ts");

// ── Fake BullMQ queue (dependency-injected, no vi.mock) ──

interface RecordedJob {
  name: string;
  data: ImportJobData;
}

function createFakeQueue() {
  const recorded: RecordedJob[] = [];
  return {
    recorded,
    // vi.fn gives the return value Mock<…> which is structurally compatible
    // with Queue<ImportJobData>.add / .getJob — avoids module-level vi.mock.
    add: vi.fn(async (name: string, data: ImportJobData) => {
      recorded.push({ name, data });
      return { id: `job-${recorded.length}` };
    }),
    getJob: vi.fn(async () => null),
  };
}

function createTestApp() {
  const queue = createFakeQueue();
  const app = express();
  app.use("/api/upload", createUploadRouter({ getImportQueue: () => queue }));
  return { app, queue };
}

// ── HTTP helpers ──

function getPort(server: ReturnType<express.Express["listen"]>): number {
  const addr = server.address();
  if (addr !== null && typeof addr === "object") {
    return (addr satisfies AddressInfo).port;
  }
  throw new Error("Server address is not an object");
}

async function post(
  app: express.Express,
  path: string,
  opts: { headers?: Record<string, string>; body: Buffer },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = getPort(server);
      fetch(`http://localhost:${port}${path}`, {
        method: "POST",
        headers: opts.headers,
        body: opts.body,
      })
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

// ── Cleanup ──

afterAll(async () => {
  await rm(TEST_JOB_DIR, { recursive: true, force: true });
  if (ORIGINAL_JOB_FILES_DIR === undefined) {
    delete process.env.JOB_FILES_DIR;
  } else {
    process.env.JOB_FILES_DIR = ORIGINAL_JOB_FILES_DIR;
  }
});

// ── Tests ──

describe("upload integration (real file I/O)", () => {
  describe("POST /api/upload/apple-health — single file", () => {
    it("writes a zip upload to disk and enqueues an import job", async () => {
      const { app, queue } = createTestApp();
      const payload = Buffer.from("PK\x03\x04fake-zip-data");

      const res = await post(app, "/api/upload/apple-health", {
        headers: { "Content-Type": "application/zip" },
        body: payload,
      });

      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.status).toBe("processing");

      // The file should physically exist and contain the bytes we sent
      expect(queue.recorded).toHaveLength(1);
      const filePath = queue.recorded[0].data.filePath;
      expect(filePath).toMatch(/\.zip$/);
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath).equals(payload)).toBe(true);
    });

    it("saves an XML file with .xml extension when content-type is XML", async () => {
      const { app, queue } = createTestApp();
      const xml = Buffer.from(
        "<HealthData><Record type='HKQuantityTypeIdentifierStepCount'/></HealthData>",
      );

      const res = await post(app, "/api/upload/apple-health", {
        headers: { "Content-Type": "application/xml" },
        body: xml,
      });

      expect(res.status).toBe(200);
      const filePath = queue.recorded[0].data.filePath;
      expect(filePath).toMatch(/\.xml$/);
      expect(readFileSync(filePath).equals(xml)).toBe(true);
    });

    it("saves .xml extension when x-file-ext is .xml on a single-chunk upload", async () => {
      const { app, queue } = createTestApp();
      const xml = Buffer.from("<HealthData></HealthData>");

      const res = await post(app, "/api/upload/apple-health", {
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upload-id": `xml-ext-integ-${Date.now()}`,
          "x-chunk-index": "0",
          "x-chunk-total": "1",
          "x-file-ext": ".xml",
        },
        body: xml,
      });

      expect(res.status).toBe(200);
      const filePath = queue.recorded[0].data.filePath;
      expect(filePath).toMatch(/\.xml$/);
      expect(readFileSync(filePath).equals(xml)).toBe(true);
    });
  });

  describe("POST /api/upload/apple-health — chunked", () => {
    it("assembles multiple chunks into a single file on disk", async () => {
      const { app, queue } = createTestApp();
      const uploadId = `integ-multi-${Date.now()}`;
      const chunks = [Buffer.from("AAAA"), Buffer.from("BBBB"), Buffer.from("CCCC")];

      // Send first two chunks — should return "uploading"
      for (let i = 0; i < 2; i++) {
        const res = await post(app, "/api/upload/apple-health", {
          headers: {
            "Content-Type": "application/octet-stream",
            "x-upload-id": uploadId,
            "x-chunk-index": String(i),
            "x-chunk-total": "3",
          },
          body: chunks[i],
        });
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body).status).toBe("uploading");
      }

      // Final chunk — responds immediately with "assembling", assembly happens in background
      const res = await post(app, "/api/upload/apple-health", {
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upload-id": uploadId,
          "x-chunk-index": "2",
          "x-chunk-total": "3",
        },
        body: chunks[2],
      });

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).status).toBe("assembling");

      // Wait for background assembly + enqueue to complete
      await vi.waitFor(() => expect(queue.recorded).toHaveLength(1), { timeout: 2000 });

      // Assembled file should contain all chunks concatenated in order
      const filePath = queue.recorded[0].data.filePath;
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath).equals(Buffer.from("AAAABBBBCCCC"))).toBe(true);
    });

    it("assembles chunks sent out of order", async () => {
      const { app, queue } = createTestApp();
      const uploadId = `integ-ooo-${Date.now()}`;

      // Send chunk 1 before chunk 0
      await post(app, "/api/upload/apple-health", {
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upload-id": uploadId,
          "x-chunk-index": "1",
          "x-chunk-total": "2",
        },
        body: Buffer.from("SECOND"),
      });

      const res = await post(app, "/api/upload/apple-health", {
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upload-id": uploadId,
          "x-chunk-index": "0",
          "x-chunk-total": "2",
        },
        body: Buffer.from("FIRST"),
      });

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).status).toBe("assembling");

      // Wait for background assembly + enqueue to complete
      await vi.waitFor(() => expect(queue.recorded).toHaveLength(1), { timeout: 2000 });

      // assembleChunks sorts by filename (chunk-000000, chunk-000001),
      // so the result should be in correct order regardless of upload order
      const filePath = queue.recorded[0].data.filePath;
      expect(readFileSync(filePath).equals(Buffer.from("FIRSTSECOND"))).toBe(true);
    });
  });

  describe("POST /api/upload/apple-health — validation", () => {
    it("rejects unsupported content types", async () => {
      const { app } = createTestApp();
      const res = await post(app, "/api/upload/apple-health", {
        headers: { "Content-Type": "text/html" },
        body: Buffer.from("<html></html>"),
      });
      expect(res.status).toBe(415);
    });

    it("rejects upload IDs with path traversal characters", async () => {
      const { app } = createTestApp();
      const res = await post(app, "/api/upload/apple-health", {
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upload-id": "../../etc/passwd",
          "x-chunk-index": "0",
          "x-chunk-total": "2",
        },
        body: Buffer.from("data"),
      });
      expect(res.status).toBe(400);
      expect(res.body).toContain("Invalid upload ID");
    });

    it("rejects non-.zip/.xml file extensions", async () => {
      const { app } = createTestApp();
      const res = await post(app, "/api/upload/apple-health", {
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upload-id": `ext-integ-${Date.now()}`,
          "x-chunk-index": "0",
          "x-chunk-total": "2",
          "x-file-ext": ".exe",
        },
        body: Buffer.from("data"),
      });
      expect(res.status).toBe(400);
      expect(res.body).toContain("Invalid file extension");
    });
  });

  describe("POST /api/upload/apple-health — enqueue arguments", () => {
    it("passes correct import type and since date for default (7-day) sync", async () => {
      const { app, queue } = createTestApp();
      const before = Date.now();

      await post(app, "/api/upload/apple-health", {
        headers: { "Content-Type": "application/zip" },
        body: Buffer.from("zip-data"),
      });

      expect(queue.recorded).toHaveLength(1);
      const job = queue.recorded[0];
      expect(job.name).toBe("apple-health");
      expect(job.data.importType).toBe("apple-health");

      // "since" should be roughly 7 days ago
      const since = new Date(job.data.since).getTime();
      const sevenDaysAgo = before - 7 * 24 * 60 * 60 * 1000;
      expect(Math.abs(since - sevenDaysAgo)).toBeLessThan(5000);
    });

    it("uses epoch as since date when fullSync=true", async () => {
      const { app, queue } = createTestApp();

      await post(app, "/api/upload/apple-health?fullSync=true", {
        headers: { "Content-Type": "application/zip" },
        body: Buffer.from("zip-data"),
      });

      expect(queue.recorded).toHaveLength(1);
      const since = new Date(queue.recorded[0].data.since).getTime();
      expect(since).toBe(0);
    });
  });

  describe("POST /api/upload/strong-csv", () => {
    it("writes CSV to disk and enqueues with correct import type", async () => {
      const { app, queue } = createTestApp();
      const csv = Buffer.from("Date,Exercise Name,Weight\n2026-01-01,Squat,100");

      const res = await post(app, "/api/upload/strong-csv", {
        headers: { "Content-Type": "text/csv" },
        body: csv,
      });

      expect(res.status).toBe(200);
      expect(queue.recorded).toHaveLength(1);
      expect(queue.recorded[0].name).toBe("strong-csv");
      expect(queue.recorded[0].data.weightUnit).toBe("kg");

      const filePath = queue.recorded[0].data.filePath;
      expect(filePath).toMatch(/\.csv$/);
      expect(readFileSync(filePath).equals(csv)).toBe(true);
    });

    it("passes lbs weight unit when units=lbs", async () => {
      const { app, queue } = createTestApp();

      await post(app, "/api/upload/strong-csv?units=lbs", {
        headers: { "Content-Type": "text/csv" },
        body: Buffer.from("data"),
      });

      expect(queue.recorded[0].data.weightUnit).toBe("lbs");
    });
  });

  describe("POST /api/upload/cronometer-csv", () => {
    it("writes CSV to disk and enqueues with correct import type", async () => {
      const { app, queue } = createTestApp();
      const csv = Buffer.from("Day,Food Name,Amount\n2026-01-01,Banana,1");

      const res = await post(app, "/api/upload/cronometer-csv", {
        headers: { "Content-Type": "text/csv" },
        body: csv,
      });

      expect(res.status).toBe(200);
      expect(queue.recorded).toHaveLength(1);
      expect(queue.recorded[0].name).toBe("cronometer-csv");

      const filePath = queue.recorded[0].data.filePath;
      expect(filePath).toMatch(/\.csv$/);
      expect(readFileSync(filePath).equals(csv)).toBe(true);
    });
  });
});
