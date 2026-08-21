import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../src/db/test-helpers.ts";
import { createSession } from "./auth/session.ts";
import { createApp } from "./index.ts";
import type { ActivitySensorStore } from "./repositories/activity-repository.ts";

const noopSensorStore = {
  query: async () => [],
  getActivitySummaries: async () => [],
  getPowerCurveSamples: async () => [],
  getNormalizedPowerSamples: async () => [],
  getVo2MaxEstimates: async () => [],
  getHeartRateCurveRows: async () => [],
  getPaceCurveRows: async () => [],
  getStream: async () => [],
  getHeartRateZoneSeconds: async () => [],
  getPowerZoneSeconds: async () => [],
  refreshBodyMeasurements: async () => {},
} satisfies ActivitySensorStore;

/**
 * Integration tests for the tRPC API layer.
 * Verifies that the Express server + tRPC middleware correctly handles
 * the request formats sent by httpBatchLink with methodOverride: "POST".
 */
describe("tRPC API", () => {
  let server: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let testCtx: TestContext;
  let sessionCookie: string;

  beforeAll(async () => {
    testCtx = await setupTestDatabase();

    const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";
    const session = await createSession(testCtx.db, TEST_USER_ID);
    sessionCookie = `session=${session.sessionId}`;

    const app = createApp(testCtx.db, noopSensorStore);
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

  describe("methodOverride: POST for queries", () => {
    it("accepts POST for queries without input", async () => {
      // httpBatchLink with methodOverride: "POST" sends queries as POST
      const res = await fetch(`${baseUrl}/api/trpc/sync.providers?batch=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: sessionCookie },
        body: JSON.stringify({ "0": {} }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveLength(1);
      expect(data[0].result).toBeDefined();
    });

    it("accepts POST for queries with required input parameters", async () => {
      // This is the exact format httpBatchLink sends (no json wrapper).
      // Without allowMethodOverride on the server, this returns 405.
      const res = await fetch(`${baseUrl}/api/trpc/sync.syncStatus?batch=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: sessionCookie },
        body: JSON.stringify({ "0": { jobId: "nonexistent-job" } }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveLength(1);
      expect(data[0].result.data).toBeNull();
    });

    it("accepts POST for queries with optional input parameters", async () => {
      const res = await fetch(`${baseUrl}/api/trpc/sync.logs?batch=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: sessionCookie },
        body: JSON.stringify({ "0": { limit: 5 } }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveLength(1);
      expect(Array.isArray(data[0].result.data)).toBe(true);
    });
  });

  describe("POST mutations", () => {
    it("triggerSync succeeds even without OAuth tokens (always-connected providers exist)", async () => {
      const res = await fetch(`${baseUrl}/api/trpc/sync.triggerSync?batch=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: sessionCookie },
        body: JSON.stringify({ "0": { sinceDays: 7 } }),
      });

      // Providers that don't require auth (e.g. auto-supplements) are always
      // connected, so triggerSync will find at least one syncable provider.
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveLength(1);
      expect(data[0].result.data.jobId).toBeDefined();
    });
  });

  describe("Prometheus metrics", () => {
    it("exposes /metrics endpoint with Prometheus format", async () => {
      const res = await fetch(`${baseUrl}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/plain");
      const body = await res.text();
      // Should contain standard prom-client metrics
      expect(body).toContain("# HELP");
      expect(body).toContain("# TYPE");
    });

    it("records HTTP request duration histogram", async () => {
      // Fire a request first to generate a metric
      await fetch(`${baseUrl}/api/trpc/sync.providers?batch=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: sessionCookie },
        body: JSON.stringify({ "0": {} }),
      });

      const res = await fetch(`${baseUrl}/metrics`);
      const body = await res.text();
      expect(body).toContain("http_request_duration_seconds");
    });

    it("records tRPC procedure duration histogram", async () => {
      await fetch(`${baseUrl}/api/trpc/sync.providers?batch=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: sessionCookie },
        body: JSON.stringify({ "0": {} }),
      });

      const res = await fetch(`${baseUrl}/metrics`);
      const body = await res.text();
      expect(body).toContain("trpc_procedure_duration_seconds");
      expect(body).toContain("trpc_db_query_duration_seconds");
      expect(body).toContain("trpc_cache_lookup_duration_seconds");
      expect(body).toContain("trpc_cache_hits_total");
      expect(body).toContain("trpc_cache_misses_total");
    });
  });

  describe("countProviderRecords uses schema-qualified tables", () => {
    it("triggerSync does not fail with 'relation does not exist'", async () => {
      // This catches the bug where raw SQL used unqualified table names
      // (e.g. cardio_activity instead of health.cardio_activity)
      const res = await fetch(`${baseUrl}/api/trpc/sync.triggerSync?batch=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: sessionCookie },
        body: JSON.stringify({ "0": { providerId: "wahoo", sinceDays: 7 } }),
      });

      const data = await res.json();
      // Should not contain "relation does not exist" error
      if (data[0].error) {
        expect(data[0].error.message).not.toContain("does not exist");
      }
    });
  });

  describe("Auth routes", () => {
    it("GET /api/auth/providers returns configured providers", async () => {
      const res = await fetch(`${baseUrl}/api/auth/providers`);
      expect(res.status).toBe(200);
      const data = await res.json();
      // Should return { identity: [...], data: [...] }
      expect(data).toHaveProperty("identity");
      expect(data).toHaveProperty("data");
      expect(Array.isArray(data.identity)).toBe(true);
      expect(Array.isArray(data.data)).toBe(true);
    });

    it("GET /api/auth/me returns user info with valid session", async () => {
      const res = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Cookie: sessionCookie },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.id).toBeDefined();
      expect(data.name).toBeDefined();
    });

    it("GET /api/auth/me returns 401 without session cookie", async () => {
      const res = await fetch(`${baseUrl}/api/auth/me`);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe("Not authenticated");
    });

    it("GET /api/auth/me returns 401 with invalid session", async () => {
      const res = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Cookie: "session=invalid-session-token" },
      });
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe("Session expired");
    });

    it("POST /auth/logout clears session and returns ok", async () => {
      // Create a dedicated session for this test
      const session = await createSession(testCtx.db, "00000000-0000-0000-0000-000000000001");
      const cookie = `session=${session.sessionId}`;

      const res = await fetch(`${baseUrl}/auth/logout`, {
        method: "POST",
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);

      // Session should be invalid now
      const meRes = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Cookie: cookie },
      });
      expect(meRes.status).toBe(401);
    });

    it("GET /auth/login/:provider returns 404 for unknown provider", async () => {
      const res = await fetch(`${baseUrl}/auth/login/unknown_provider`, {
        redirect: "manual",
      });
      expect(res.status).toBe(404);
    });

    it("GET /auth/callback/:provider returns 404 for unknown provider", async () => {
      const res = await fetch(`${baseUrl}/auth/callback/unknown_provider?code=test&state=test`);
      expect(res.status).toBe(404);
    });

    it("GET /auth/callback/:provider returns 400 when error param is present", async () => {
      const res = await fetch(`${baseUrl}/auth/callback/google?error=access_denied`);
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain("Authorization denied");
    });

    it("GET /auth/callback/:provider returns 400 when code/state missing", async () => {
      const res = await fetch(`${baseUrl}/auth/callback/google`);
      expect(res.status).toBe(400);
    });
  });

  describe("OAuth callback", () => {
    it("GET /callback with no params returns OK (health check)", async () => {
      const res = await fetch(`${baseUrl}/callback`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toBe("OK");
    });

    it("GET /callback with error param returns 400", async () => {
      const res = await fetch(`${baseUrl}/callback?error=access_denied`);
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain("Authorization denied");
    });

    it("GET /callback with unknown state returns 400", async () => {
      const res = await fetch(`${baseUrl}/callback?code=test&state=unknown`);
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain("Unknown or expired OAuth state");
    });
  });

  describe("Metrics at /api/metrics", () => {
    it("exposes /api/metrics endpoint (mirrors /metrics)", async () => {
      const res = await fetch(`${baseUrl}/api/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/plain");
      const body = await res.text();
      expect(body).toContain("# HELP");
    });
  });

  describe("Auth login flow", () => {
    it("GET /auth/login/:provider returns 400 or redirects to provider", async () => {
      // google is a valid identity provider name
      const res = await fetch(`${baseUrl}/auth/login/google`, {
        redirect: "manual",
      });
      // If configured in CI, it will redirect (302). If not, 400.
      expect([302, 400]).toContain(res.status);
      if (res.status === 302) {
        expect(res.headers.get("location")).toContain("accounts.google.com");
      } else {
        const body = await res.text();
        expect(body).toContain("not configured");
      }
    });
  });

  describe("Auth callback state validation", () => {
    it("GET /auth/callback/:provider returns 400 with mismatched state", async () => {
      // Valid provider, code+state present, but no matching cookie
      const res = await fetch(
        `${baseUrl}/auth/callback/google?code=testcode&state=google:somebogusstate`,
      );
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain("Invalid state");
    });
  });

  describe("Logout without session", () => {
    it("POST /auth/logout returns ok even without session cookie", async () => {
      const res = await fetch(`${baseUrl}/auth/logout`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
    });
  });

  describe("OAuth 1.0 callback", () => {
    it("GET /callback with unknown oauth_token returns 400", async () => {
      const res = await fetch(`${baseUrl}/callback?oauth_token=unknown&oauth_verifier=test`);
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain("Unknown or expired OAuth 1.0 request token");
    });
  });

  describe("Data provider OAuth", () => {
    it("GET /auth/provider/:provider returns 404 for unknown provider", async () => {
      const res = await fetch(`${baseUrl}/auth/provider/nonexistent`, {
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

  describe("OAuth callback with missing code", () => {
    it("GET /callback with only state returns 400 for missing code", async () => {
      const res = await fetch(`${baseUrl}/callback?state=somestate`);
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain("Missing code or state");
    });

    it("GET /callback with only code returns 400 for missing state", async () => {
      const res = await fetch(`${baseUrl}/callback?code=somecode`);
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain("Missing code or state");
    });
  });

  describe("Admin middleware (/admin/queues)", () => {
    it("returns 401 when no session cookie is provided", async () => {
      const res = await fetch(`${baseUrl}/admin/queues`);
      expect(res.status).toBe(401);
      expect(await res.text()).toBe("Authentication required");
    });

    it("returns 401 when session is invalid or expired", async () => {
      const res = await fetch(`${baseUrl}/admin/queues`, {
        headers: { Cookie: "session=invalid-session" },
      });
      expect(res.status).toBe(401);
      expect(await res.text()).toBe("Session expired");
    });

    it("returns 403 when user is not admin", async () => {
      // Non-admin user session
      const res = await fetch(`${baseUrl}/admin/queues`, {
        headers: { Cookie: sessionCookie },
      });
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("Admin access required");
    });
  });
});
