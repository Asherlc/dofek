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
  logger: { error: vi.fn(), warn: vi.fn() },
}));

const mockCreateSignedExportDownloadUrl = vi.fn();

import type { AddressInfo } from "node:net";
import cookieParser from "cookie-parser";
import express from "express";
import { getSessionIdFromRequest } from "../auth/cookies.ts";
import { validateSession } from "../auth/session.ts";
import { createExportRouter } from "./export.ts";

const createdExportId = "11111111-1111-1111-1111-111111111111";
const otherExportId = "22222222-2222-2222-2222-222222222222";
const exportUserId = "33333333-3333-3333-3333-333333333333";
const otherUserId = "44444444-4444-4444-4444-444444444444";

type MockDatabase = Parameters<typeof createExportRouter>[0]["db"];
type MockQueue = NonNullable<Parameters<typeof createExportRouter>[0]["exportQueue"]>;

const mockDatabase: MockDatabase = {
  execute: vi.fn(),
};

const mockQueue = {
  add: vi.fn().mockResolvedValue({ id: "job-42" }),
} satisfies MockQueue;

function mockExecute() {
  return vi.mocked(mockDatabase.execute);
}

function createTestApp() {
  const app = express();
  app.use(cookieParser());
  app.use(
    "/api/export",
    createExportRouter({
      createSignedDownloadUrl: mockCreateSignedExportDownloadUrl,
      db: mockDatabase,
      exportQueue: mockQueue,
    }),
  );
  return app;
}

function getPort(server: ReturnType<express.Express["listen"]>): number {
  const address = server.address();
  if (address !== null && typeof address === "object") {
    return (address satisfies AddressInfo).port;
  }
  throw new Error("Server address is not an object");
}

async function request(
  app: express.Express,
  method: "get" | "post",
  path: string,
): Promise<{ headers: Headers; status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = getPort(server);
      fetch(`http://localhost:${port}${path}`, { method: method.toUpperCase(), redirect: "manual" })
        .then(async (response) => {
          resolve({
            headers: response.headers,
            status: response.status,
            text: await response.text(),
          });
          server.close();
        })
        .catch((error: unknown) => {
          server.close();
          reject(error);
        });
    });
  });
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

function authenticate(userId = exportUserId) {
  vi.mocked(getSessionIdFromRequest).mockReturnValue("session-1");
  vi.mocked(validateSession).mockResolvedValue({ userId });
}

describe("createExportRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute().mockReset();
    vi.mocked(mockQueue.add).mockResolvedValue({ id: "job-42" });
    mockCreateSignedExportDownloadUrl.mockResolvedValue(
      "https://r2.example.test/signed-export.zip",
    );
  });

  describe("POST /api/export", () => {
    it("returns 401 when not authenticated", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue(undefined);
      const response = await request(createTestApp(), "post", "/api/export");
      expect(response.status).toBe(401);
    });

    it("creates a queued export record and enqueues the export job", async () => {
      authenticate();
      mockExecute().mockResolvedValueOnce([{ id: createdExportId }]);

      const response = await request(createTestApp(), "post", "/api/export");

      expect(response.status).toBe(200);
      expect(parseJson(response.text)).toEqual({ status: "queued", exportId: createdExportId });
      expect(mockExecute()).toHaveBeenCalledTimes(1);
      expect(vi.mocked(mockQueue.add)).toHaveBeenCalledWith(
        "export",
        expect.objectContaining({
          exportId: createdExportId,
          userId: exportUserId,
          outputPath: expect.stringContaining("dofek-export-"),
        }),
      );
    });
  });

  describe("GET /api/export", () => {
    it("returns only authenticated user's active and unexpired completed exports", async () => {
      authenticate();
      mockExecute().mockResolvedValueOnce([
        {
          id: createdExportId,
          status: "processing",
          filename: "dofek-export.zip",
          size_bytes: null,
          created_at: "2026-04-26T12:00:00.000Z",
          started_at: "2026-04-26T12:01:00.000Z",
          completed_at: null,
          expires_at: "2026-05-03T12:00:00.000Z",
          error_message: null,
        },
        {
          id: otherExportId,
          status: "completed",
          filename: "dofek-export.zip",
          size_bytes: "1234",
          created_at: "2026-04-25T12:00:00.000Z",
          started_at: "2026-04-25T12:01:00.000Z",
          completed_at: "2026-04-25T12:02:00.000Z",
          expires_at: "2026-05-02T12:00:00.000Z",
          error_message: null,
        },
      ]);

      const response = await request(createTestApp(), "get", "/api/export");

      expect(response.status).toBe(200);
      expect(parseJson(response.text)).toEqual({
        exports: [
          {
            id: createdExportId,
            status: "processing",
            filename: "dofek-export.zip",
            sizeBytes: null,
            createdAt: "2026-04-26T12:00:00.000Z",
            startedAt: "2026-04-26T12:01:00.000Z",
            completedAt: null,
            expiresAt: "2026-05-03T12:00:00.000Z",
            errorMessage: null,
          },
          {
            id: otherExportId,
            status: "completed",
            filename: "dofek-export.zip",
            sizeBytes: 1234,
            createdAt: "2026-04-25T12:00:00.000Z",
            startedAt: "2026-04-25T12:01:00.000Z",
            completedAt: "2026-04-25T12:02:00.000Z",
            expiresAt: "2026-05-02T12:00:00.000Z",
            errorMessage: null,
          },
        ],
      });
    });
  });

  describe("GET /api/export/download/:exportId", () => {
    it("returns 403 when the export belongs to another user", async () => {
      authenticate(otherUserId);
      mockExecute().mockResolvedValueOnce([
        {
          user_id: exportUserId,
          status: "completed",
          object_key: "exports/user/export/dofek-export.zip",
          expires_at: "2999-05-03T12:00:00.000Z",
        },
      ]);

      const response = await request(
        createTestApp(),
        "get",
        `/api/export/download/${createdExportId}`,
      );

      expect(response.status).toBe(403);
    });

    it("returns 400 when the export is not completed", async () => {
      authenticate();
      mockExecute().mockResolvedValueOnce([
        {
          user_id: exportUserId,
          status: "processing",
          object_key: null,
          expires_at: "2026-05-03T12:00:00.000Z",
        },
      ]);

      const response = await request(
        createTestApp(),
        "get",
        `/api/export/download/${createdExportId}`,
      );

      expect(response.status).toBe(400);
      expect(parseJson(response.text)).toEqual({ error: "Export is not ready yet" });
    });

    it("redirects a completed owned export to a signed R2 URL", async () => {
      authenticate();
      mockExecute().mockResolvedValueOnce([
        {
          user_id: exportUserId,
          status: "completed",
          object_key: "exports/user-1/export-1/dofek-export.zip",
          expires_at: "2999-05-03T12:00:00.000Z",
        },
      ]);

      const response = await request(
        createTestApp(),
        "get",
        `/api/export/download/${createdExportId}`,
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("https://r2.example.test/signed-export.zip");
      expect(mockCreateSignedExportDownloadUrl).toHaveBeenCalledWith(
        "exports/user-1/export-1/dofek-export.zip",
      );
    });
  });
});
