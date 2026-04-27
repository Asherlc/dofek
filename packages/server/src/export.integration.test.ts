import type { Server } from "node:http";
import { TEST_USER_ID } from "dofek/db/schema";
import type { ExportJobData } from "dofek/jobs/queues";
import { sql } from "drizzle-orm";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../src/db/test-helpers.ts";
import { createSession } from "./auth/session.ts";
import { createExportRouter } from "./routes/export.ts";

const exportStorageMocks = vi.hoisted(() => ({
  createSignedExportDownloadUrl: vi.fn(
    async (objectKey: string) => `https://r2.example.test/${objectKey}`,
  ),
  uploadExportFileToR2: vi.fn(
    async (_filePath: string, options: { exportId: string; userId: string }) => ({
      objectKey: `exports/${options.userId}/${options.exportId}/dofek-export.zip`,
      sizeBytes: 2048,
    }),
  ),
}));

vi.mock("../../../src/export-storage.ts", () => exportStorageMocks);
vi.mock("dofek/export-storage", () => exportStorageMocks);

interface ExportResponse {
  completedAt: string | null;
  createdAt: string;
  errorMessage: string | null;
  expiresAt: string;
  filename: string;
  id: string;
  sizeBytes: number | null;
  startedAt: string | null;
  status: string;
}

interface ExportListResponse {
  exports: ExportResponse[];
}

async function waitForCompletedExport(
  baseUrl: string,
  authorizationHeader: string,
  exportId: string,
) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/export`, {
      headers: { Authorization: authorizationHeader },
    });
    const body: ExportListResponse = await response.json();
    const dataExport = body.exports.find((exportRecord) => exportRecord.id === exportId);
    if (dataExport?.status === "completed") {
      return dataExport;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Export ${exportId} did not complete`);
}

describe("Data Export", () => {
  let testCtx: TestContext;
  let server: Server;
  let baseUrl: string;
  let authorizationHeader: string;
  let queuedExportJobs: ExportJobData[];

  beforeEach(() => {
    queuedExportJobs = [];
    vi.clearAllMocks();
  });

  beforeAll(async () => {
    testCtx = await setupTestDatabase();

    await testCtx.db.execute(
      sql`UPDATE fitness.user_profile SET email = 'test@example.com' WHERE id = ${TEST_USER_ID}`,
    );

    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id) VALUES ('test-provider', 'Test Provider', ${TEST_USER_ID})`,
    );

    await testCtx.db.execute(
      sql`INSERT INTO fitness.activity (id, provider_id, user_id, activity_type, started_at, name, raw)
          VALUES ('11111111-1111-1111-1111-111111111111', 'test-provider', ${TEST_USER_ID}, 'cycling', '2024-01-15T10:00:00Z', 'Morning Ride', '{"source": "test"}'::jsonb)`,
    );

    const session = await createSession(testCtx.db, TEST_USER_ID);
    authorizationHeader = `Bearer ${session.sessionId}`;

    const exportQueue = {
      add: vi.fn(async (_name: string, data: ExportJobData) => {
        queuedExportJobs.push(data);
        return { id: data.exportId };
      }),
    };

    const app = express();
    app.use(
      "/api/export",
      createExportRouter({ db: testCtx.db, exportQueue, startExportWorker: () => undefined }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  }, 120_000);

  afterAll(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    await testCtx?.cleanup();
  });

  it("queues an offline export and lists it for the authenticated user", async () => {
    const response = await fetch(`${baseUrl}/api/export`, {
      method: "POST",
      headers: { Authorization: authorizationHeader },
    });
    expect(response.status).toBe(200);
    const body: { status: string; exportId: string } = await response.json();
    expect(body.status).toBe("queued");
    expect(body.exportId).toBeTruthy();

    const listResponse = await fetch(`${baseUrl}/api/export`, {
      headers: { Authorization: authorizationHeader },
    });
    const listBody: ExportListResponse = await listResponse.json();
    const queuedExport = listBody.exports.find((dataExport) => dataExport.id === body.exportId);
    expect(queuedExport).toBeDefined();
    if (!queuedExport) {
      throw new Error(`Export ${body.exportId} was not listed`);
    }
    const ttlMs = new Date(queuedExport.expiresAt).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
    expect(ttlMs).toBeLessThan(7.1 * 24 * 60 * 60 * 1000);
  });

  it("returns 401 for unauthenticated export request", async () => {
    const response = await fetch(`${baseUrl}/api/export`, { method: "POST" });
    expect(response.status).toBe(401);
  });

  it("returns 404 for unknown export status", async () => {
    const unknownExportId = "99999999-9999-4999-8999-999999999999";
    const response = await fetch(`${baseUrl}/api/export/status/${unknownExportId}`, {
      headers: { Authorization: authorizationHeader },
    });
    expect(response.status).toBe(404);
  });

  it("redirects completed user-scoped exports to signed R2 URLs", async () => {
    const triggerResponse = await fetch(`${baseUrl}/api/export`, {
      method: "POST",
      headers: { Authorization: authorizationHeader },
    });
    expect(triggerResponse.status).toBe(200);
    const { exportId }: { exportId: string } = await triggerResponse.json();
    const queuedJob = queuedExportJobs.find((job) => job.exportId === exportId);
    if (!queuedJob) {
      throw new Error(`Export ${exportId} was not enqueued`);
    }

    const objectKey = `exports/${TEST_USER_ID}/${exportId}/dofek-export.zip`;
    await testCtx.db.execute(
      sql`UPDATE fitness.data_export
          SET status = 'completed',
            object_key = ${objectKey},
            size_bytes = 2048,
            completed_at = NOW()
          WHERE id = ${exportId} AND user_id = ${TEST_USER_ID}`,
    );

    const completedExport = await waitForCompletedExport(baseUrl, authorizationHeader, exportId);

    expect(completedExport.sizeBytes).toBe(2048);

    const downloadResponse = await fetch(`${baseUrl}/api/export/download/${exportId}`, {
      headers: { Authorization: authorizationHeader },
      redirect: "manual",
    });
    expect(downloadResponse.status).toBe(302);
    expect(downloadResponse.headers.get("location")).toBe(
      `https://r2.example.test/exports/${TEST_USER_ID}/${exportId}/dofek-export.zip`,
    );
  }, 60_000);

  it("returns 401 for unauthenticated download", async () => {
    const exportId = "44444444-4444-4444-8444-444444444444";
    const downloadResponse = await fetch(`${baseUrl}/api/export/download/${exportId}`);
    expect(downloadResponse.status).toBe(401);
  });

  it("lists exports only for the authenticated user", async () => {
    const otherUserId = "22222222-2222-4222-8222-222222222222";
    await testCtx.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name, email)
          VALUES (${otherUserId}, 'Other User', 'other@example.com')
          ON CONFLICT (id) DO NOTHING`,
    );
    await testCtx.db.execute(
      sql`INSERT INTO fitness.data_export (id, user_id, status, filename, expires_at)
          VALUES ('33333333-3333-4333-8333-333333333333', ${otherUserId}, 'queued', 'dofek-export.zip', NOW() + INTERVAL '7 days')
          ON CONFLICT (id) DO NOTHING`,
    );

    const response = await fetch(`${baseUrl}/api/export`, {
      headers: { Authorization: authorizationHeader },
    });
    const body: ExportListResponse = await response.json();

    expect(
      body.exports.some((dataExport) => dataExport.id === "33333333-3333-4333-8333-333333333333"),
    ).toBe(false);
    expect(body.exports.every((dataExport) => dataExport.filename === "dofek-export.zip")).toBe(
      true,
    );
  });
});
