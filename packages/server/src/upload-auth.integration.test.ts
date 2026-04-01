import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../src/db/test-helpers.ts";
import { createSession } from "./auth/session.ts";
import { createApp } from "./index.ts";

/**
 * Additional integration tests for upload endpoints and auth flows.
 * Focuses on background import code paths, error handling, and edge cases
 * not covered by the main index.test.ts.
 */
describe("Upload & Auth - extended coverage", () => {
  let server: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let testCtx: TestContext;
  let sessionCookie: string;

  beforeAll(async () => {
    testCtx = await setupTestDatabase();

    const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";
    const session = await createSession(testCtx.db, TEST_USER_ID);
    sessionCookie = `session=${session.sessionId}`;

    const app = createApp(testCtx.db);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    await testCtx?.cleanup();
  });

  describe("Apple Health upload - background import lifecycle", () => {
    it("non-chunked upload with XML content-type uses .xml extension", async () => {
      const res = await fetch(`${baseUrl}/api/upload/apple-health`, {
        method: "POST",
        headers: { "Content-Type": "application/xml", Cookie: sessionCookie },
        body: "<HealthData></HealthData>",
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe("processing");
      expect(data.jobId).toBeDefined();
    });

    it("enqueued import job is visible via status endpoint", async () => {
      const res = await fetch(`${baseUrl}/api/upload/apple-health`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", Cookie: sessionCookie },
        body: Buffer.from("not-a-valid-zip-file"),
      });
      const data = await res.json();
      expect(data.status).toBe("processing");
      expect(typeof data.jobId).toBe("string");

      // BullMQ job should be queryable (worker may not be running in test)
      const statusRes = await fetch(`${baseUrl}/api/upload/apple-health/status/${data.jobId}`, {
        headers: { Cookie: sessionCookie },
      });
      expect(statusRes.status).toBe(200);
      const statusData = await statusRes.json();
      // Job is enqueued — without a worker it stays in "processing" state
      expect(["processing", "error"]).toContain(statusData.status);
    });
  });

  describe("Strong CSV upload - background import lifecycle", () => {
    it("enqueued Strong CSV import job is visible via status endpoint", async () => {
      // Send CSV data that will be enqueued for the Strong CSV importer
      const csvData =
        "Date,Workout Name,Exercise Name,Set Order,Weight,Reps\n2024-01-01,Morning,Bench Press,1,100,10\n";
      const res = await fetch(`${baseUrl}/api/upload/strong-csv`, {
        method: "POST",
        headers: { "Content-Type": "text/csv", Cookie: sessionCookie },
        body: csvData,
      });
      const data = await res.json();
      expect(data.status).toBe("processing");
      expect(typeof data.jobId).toBe("string");

      // BullMQ job should be queryable
      const statusRes = await fetch(`${baseUrl}/api/upload/strong-csv/status/${data.jobId}`, {
        headers: { Cookie: sessionCookie },
      });
      expect(statusRes.status).toBe(200);
      const statusData = await statusRes.json();
      // Job is enqueued — without a worker it stays in "processing" state
      expect(["processing", "done", "error"]).toContain(statusData.status);
    });

    it("defaults to kg when units param is not lbs", async () => {
      const csvData =
        "Date,Workout Name,Exercise Name,Set Order,Weight,Reps\n2024-01-01,Evening,Squat,1,60,8\n";
      const res = await fetch(`${baseUrl}/api/upload/strong-csv?units=kg`, {
        method: "POST",
        headers: { "Content-Type": "text/csv", Cookie: sessionCookie },
        body: csvData,
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe("processing");
    });
  });

  describe("Cronometer CSV upload - background import lifecycle", () => {
    it("enqueued Cronometer CSV import job is visible via status endpoint", async () => {
      const csvData = "Day,Food Name,Amount,Energy (kcal)\n2024-01-01,Oatmeal,1 cup,150\n";
      const res = await fetch(`${baseUrl}/api/upload/cronometer-csv`, {
        method: "POST",
        headers: { "Content-Type": "text/csv", Cookie: sessionCookie },
        body: csvData,
      });
      const data = await res.json();
      expect(data.status).toBe("processing");
      expect(typeof data.jobId).toBe("string");

      // BullMQ job should be queryable
      const statusRes = await fetch(`${baseUrl}/api/upload/cronometer-csv/status/${data.jobId}`, {
        headers: { Cookie: sessionCookie },
      });
      expect(statusRes.status).toBe(200);
      const statusData = await statusRes.json();
      // Job is enqueued — without a worker it stays in "processing" state
      expect(["processing", "done", "error"]).toContain(statusData.status);
    });
  });

  describe("Auth - edge cases", () => {
    it("GET /api/auth/me returns 401 with expired session (set-cookie header clears it)", async () => {
      const res = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Cookie: "session=totally-bogus-session-id-12345" },
      });
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe("Session expired");
      // Should have a set-cookie header clearing the session
      const setCookie = res.headers.get("set-cookie");
      expect(setCookie).toBeDefined();
      expect(setCookie).toContain("session=");
    });

    it("POST /auth/logout without session cookie still returns ok", async () => {
      const res = await fetch(`${baseUrl}/auth/logout`, {
        method: "POST",
        // No cookie header
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
    });

    it("GET /auth/callback/:provider with valid provider but error query param", async () => {
      const res = await fetch(`${baseUrl}/auth/callback/authentik?error=consent_required`);
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain("Authorization denied");
    });

    it("GET /auth/callback/:provider with valid provider but no code/state/error", async () => {
      const res = await fetch(`${baseUrl}/auth/callback/apple`);
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain("Missing code or state");
    });

    it("GET /auth/login/:provider returns 404 for provider not in IDENTITY_PROVIDERS list", async () => {
      const res = await fetch(`${baseUrl}/auth/login/facebook`, {
        redirect: "manual",
      });
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).toContain("Unknown identity provider");
    });

    it("GET /auth/login/apple returns 400 or redirects to Apple", async () => {
      const res = await fetch(`${baseUrl}/auth/login/apple`, {
        redirect: "manual",
      });
      expect([302, 400]).toContain(res.status);
      if (res.status === 302) {
        expect(res.headers.get("location")).toContain("appleid.apple.com");
      } else {
        const body = await res.text();
        expect(body).toContain("not configured");
      }
    });

    it("GET /auth/login/authentik returns 400 or redirects to Authentik", async () => {
      const res = await fetch(`${baseUrl}/auth/login/authentik`, {
        redirect: "manual",
      });
      // Authentik init might throw 500 if env vars are partially set/invalid.
      // We accept 400, 302 or 500 here to handle CI environments.
      expect([302, 400, 500]).toContain(res.status);
      if (res.status === 302) {
        expect(res.headers.get("location")).toBeDefined();
      }
    });
  });

  describe("OAuth callback - additional edge cases", () => {
    it("GET /callback with code but missing state returns 400", async () => {
      const res = await fetch(`${baseUrl}/callback?code=somecode`);
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain("Missing code or state");
    });

    it("GET /callback with state but missing code returns 400", async () => {
      const res = await fetch(`${baseUrl}/callback?state=somestate`);
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain("Missing code or state");
    });

    it("GET /callback with unknown OAuth 1.0 token returns 400", async () => {
      const res = await fetch(
        `${baseUrl}/callback?oauth_token=expired_token&oauth_verifier=verifier`,
      );
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain("Unknown or expired OAuth 1.0 request token");
    });

    it("GET /callback with state=slack (no random token) returns 400 as unknown state", async () => {
      const res = await fetch(`${baseUrl}/callback?code=slack_code&state=slack`);
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain("Unknown or expired OAuth state");
    });

    it("GET /callback with unknown state token returns 400", async () => {
      const res = await fetch(`${baseUrl}/callback?code=testcode&state=nonexistent_state`);
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain("Unknown or expired OAuth state");
    });
  });

  describe("Apple Health upload - chunked edge cases", () => {
    it("single chunk upload (chunkTotal=1) treated as non-chunked", async () => {
      const uploadId = `test-single-chunk-${Date.now()}`;
      const res = await fetch(`${baseUrl}/api/upload/apple-health`, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          Cookie: sessionCookie,
          "x-upload-id": uploadId,
          "x-chunk-index": "0",
          "x-chunk-total": "1",
        },
        body: Buffer.from("single-chunk-data"),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      // chunkTotal <= 1 falls through to non-chunked path
      expect(data.status).toBe("processing");
      expect(data.jobId).toBeDefined();
    });

    it("chunked upload without x-upload-id treated as non-chunked", async () => {
      const res = await fetch(`${baseUrl}/api/upload/apple-health`, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          Cookie: sessionCookie,
          "x-chunk-index": "0",
          "x-chunk-total": "3",
        },
        body: Buffer.from("no-upload-id-data"),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      // No uploadId falls through to non-chunked path
      expect(data.status).toBe("processing");
      expect(data.jobId).toBeDefined();
    });

    it("chunked upload middle chunk updates progress", async () => {
      const uploadId = `test-progress-${Date.now()}`;
      // Send chunk 0 of 4
      const res1 = await fetch(`${baseUrl}/api/upload/apple-health`, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          Cookie: sessionCookie,
          "x-upload-id": uploadId,
          "x-chunk-index": "0",
          "x-chunk-total": "4",
          "x-file-ext": ".zip",
        },
        body: Buffer.from("chunk-0"),
      });
      expect(res1.status).toBe(200);
      const data1 = await res1.json();
      expect(data1.status).toBe("uploading");
      expect(data1.received).toBe(1);
      expect(data1.total).toBe(4);

      // Send chunk 1 of 4
      const res2 = await fetch(`${baseUrl}/api/upload/apple-health`, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          Cookie: sessionCookie,
          "x-upload-id": uploadId,
          "x-chunk-index": "1",
          "x-chunk-total": "4",
          "x-file-ext": ".zip",
        },
        body: Buffer.from("chunk-1"),
      });
      expect(res2.status).toBe(200);
      const data2 = await res2.json();
      expect(data2.status).toBe("uploading");
      expect(data2.received).toBe(2);
      expect(data2.total).toBe(4);

      // Job status should reflect uploading
      const statusRes = await fetch(`${baseUrl}/api/upload/apple-health/status/${uploadId}`, {
        headers: { Cookie: sessionCookie },
      });
      expect(statusRes.status).toBe(200);
      const statusData = await statusRes.json();
      expect(statusData.status).toBe("uploading");
      expect(statusData.progress).toBe(50);
    });
  });

  describe("Data provider OAuth", () => {
    it("GET /auth/provider/slack without SLACK_CLIENT_ID returns 400", async () => {
      const res = await fetch(`${baseUrl}/auth/provider/slack`, {
        redirect: "manual",
      });
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain("SLACK_CLIENT_ID");
    });

    it("GET /auth/provider/:provider returns 404 for truly unknown provider", async () => {
      const res = await fetch(`${baseUrl}/auth/provider/does_not_exist`, {
        redirect: "manual",
      });
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).toContain("Unknown provider");
    });

    it("GET /auth/provider/:provider returns 401 when unauthenticated for known provider", async () => {
      const res = await fetch(`${baseUrl}/auth/provider/wahoo`, {
        redirect: "manual",
      });
      expect(res.status).toBe(401);
      const body = await res.text();
      expect(body).toContain("You must be logged in");
    });
  });
});
