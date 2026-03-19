import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SyncResult } from "./providers/types.ts";
import { createUploadHandler, parseSince } from "./upload-server.ts";

const mockLoggerInfo = vi.fn();
const mockLoggerError = vi.fn();

vi.mock("./logger.ts", () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// parseSince
// ---------------------------------------------------------------------------

describe("parseSince", () => {
  it("returns a date ~7 days ago with default params", () => {
    const url = new URL("http://localhost/upload/apple-health");
    const before = Date.now();
    const result = parseSince(url);
    const after = Date.now();

    const expectedMs = 7 * 24 * 60 * 60 * 1000;
    expect(result.getTime()).toBeGreaterThanOrEqual(before - expectedMs);
    expect(result.getTime()).toBeLessThanOrEqual(after - expectedMs);
  });

  it("parses since-days=14 from query params", () => {
    const url = new URL("http://localhost/upload/apple-health?since-days=14");
    const before = Date.now();
    const result = parseSince(url);
    const after = Date.now();

    const expectedMs = 14 * 24 * 60 * 60 * 1000;
    expect(result.getTime()).toBeGreaterThanOrEqual(before - expectedMs);
    expect(result.getTime()).toBeLessThanOrEqual(after - expectedMs);
  });

  it("returns epoch when full-sync=true", () => {
    const url = new URL("http://localhost/upload/apple-health?full-sync=true");
    expect(parseSince(url).getTime()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// createUploadHandler — HTTP integration tests
// ---------------------------------------------------------------------------

describe("createUploadHandler", () => {
  let server: Server;
  let baseUrl: string;

  const mockImportResult: SyncResult = {
    provider: "apple-health",
    recordsSynced: 42,
    errors: [],
    duration: 500,
  };

  const mockImportAppleHealth = vi.fn<(...args: unknown[]) => Promise<SyncResult>>();
  // biome lint requires no `as` casts — use Object.create(null) like other test files
  const mockDb = Object.create(null);
  const mockCreateDatabase = vi.fn(() => mockDb);

  function setup(apiKey: string | undefined) {
    const handler = createUploadHandler({
      createDatabase: mockCreateDatabase,
      importAppleHealth: mockImportAppleHealth,
      apiKey,
    });
    server = createServer(handler);
    return new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  }

  function teardown() {
    return new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  afterAll(() => {
    vi.restoreAllMocks();
  });

  describe("GET /health", () => {
    beforeAll(async () => {
      await setup(undefined);
    });

    afterAll(async () => {
      await teardown();
    });

    it("returns 200 with { status: 'ok' } and JSON content type", async () => {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ status: "ok" });
    });
  });

  describe("method matching", () => {
    beforeAll(async () => {
      mockImportAppleHealth.mockResolvedValue(mockImportResult);
      await setup(undefined);
    });

    afterAll(async () => {
      await teardown();
      mockImportAppleHealth.mockReset();
    });

    it("returns 404 for POST /health (wrong method)", async () => {
      const res = await fetch(`${baseUrl}/health`, { method: "POST", body: "data" });
      expect(res.status).toBe(404);
    });

    it("returns 404 for GET /upload/apple-health (wrong method)", async () => {
      const res = await fetch(`${baseUrl}/upload/apple-health`);
      expect(res.status).toBe(404);
    });

    it("matches /upload/apple-health prefix with query params", async () => {
      const res = await fetch(`${baseUrl}/upload/apple-health?since-days=14`, {
        method: "POST",
        body: "data",
      });
      expect(res.status).toBe(200);
    });

    it("returns 404 for POST /upload/other-provider", async () => {
      const res = await fetch(`${baseUrl}/upload/other-provider`, {
        method: "POST",
        body: "data",
      });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /upload/apple-health without auth (apiKey undefined)", () => {
    beforeAll(async () => {
      mockImportAppleHealth.mockResolvedValue(mockImportResult);
      await setup(undefined);
    });

    afterAll(async () => {
      await teardown();
      mockImportAppleHealth.mockReset();
    });

    it("accepts upload and returns import result with JSON content type", async () => {
      const res = await fetch(`${baseUrl}/upload/apple-health`, {
        method: "POST",
        body: "fake-zip-data",
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = await res.json();
      expect(body.recordsSynced).toBe(42);
      expect(body.errors).toEqual([]);
      expect(body.duration).toBe(500);
      expect(mockImportAppleHealth).toHaveBeenCalledOnce();
    });

    it("logs upload receipt", async () => {
      mockLoggerInfo.mockClear();
      mockImportAppleHealth.mockResolvedValueOnce(mockImportResult);
      await fetch(`${baseUrl}/upload/apple-health`, {
        method: "POST",
        body: "data",
      });
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.stringContaining("[server] Received upload"),
      );
    });
  });

  describe("POST /upload/apple-health with auth", () => {
    const apiKey = "test-secret-key";

    beforeAll(async () => {
      mockImportAppleHealth.mockResolvedValue(mockImportResult);
      await setup(apiKey);
    });

    afterAll(async () => {
      await teardown();
      mockImportAppleHealth.mockReset();
    });

    it("returns 401 with wrong Bearer token and JSON content type", async () => {
      const res = await fetch(`${baseUrl}/upload/apple-health`, {
        method: "POST",
        headers: { Authorization: "Bearer wrong-key" },
        body: "data",
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ error: "Unauthorized" });
    });

    it("succeeds with correct Bearer token", async () => {
      const res = await fetch(`${baseUrl}/upload/apple-health`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: "data",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.recordsSynced).toBe(42);
    });
  });

  describe("POST /upload/apple-health error handling", () => {
    beforeAll(async () => {
      await setup(undefined);
    });

    afterAll(async () => {
      await teardown();
      mockImportAppleHealth.mockReset();
    });

    it("returns 500 when import throws with JSON content type", async () => {
      mockLoggerError.mockClear();
      mockImportAppleHealth.mockRejectedValueOnce(new Error("disk full"));
      const res = await fetch(`${baseUrl}/upload/apple-health`, {
        method: "POST",
        body: "data",
      });
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ error: "disk full" });
      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.stringContaining("[server] Import failed:"),
      );
    });

    it("returns 207 when import has partial errors with JSON content type", async () => {
      mockImportAppleHealth.mockResolvedValueOnce({
        ...mockImportResult,
        errors: [{ message: "bad record" }],
      });
      const res = await fetch(`${baseUrl}/upload/apple-health`, {
        method: "POST",
        body: "data",
      });
      expect(res.status).toBe(207);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = await res.json();
      expect(body.errors).toEqual(["bad record"]);
    });
  });

  describe("unknown routes", () => {
    beforeAll(async () => {
      await setup(undefined);
    });

    afterAll(async () => {
      await teardown();
    });

    it("returns 404 for GET /unknown with JSON content type", async () => {
      const res = await fetch(`${baseUrl}/unknown`);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ error: "Not found" });
    });
  });
});
