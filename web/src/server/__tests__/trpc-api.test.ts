import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/__tests__/test-helpers.ts";
import { createApp } from "../index.ts";

/**
 * Integration tests for the tRPC API layer.
 * Verifies that the Express server + tRPC middleware correctly handles
 * the request formats sent by httpBatchLink with methodOverride: "POST".
 */
describe("tRPC API", () => {
  let server: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let testCtx: TestContext;

  beforeAll(async () => {
    testCtx = await setupTestDatabase();
    const app = createApp(testCtx.db);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
    await testCtx?.cleanup();
  });

  describe("methodOverride: POST for queries", () => {
    it("accepts POST for queries without input", async () => {
      // httpBatchLink with methodOverride: "POST" sends queries as POST
      const res = await fetch(`${baseUrl}/api/trpc/sync.providers?batch=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
        headers: { "Content-Type": "application/json" },
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ "0": { limit: 5 } }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveLength(1);
      expect(Array.isArray(data[0].result.data)).toBe(true);
    });
  });

  describe("POST mutations", () => {
    it("handles triggerSync mutation with sinceDays", async () => {
      const res = await fetch(`${baseUrl}/api/trpc/sync.triggerSync?batch=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ "0": { sinceDays: 7 } }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveLength(1);
      expect(data[0].result.data.jobId).toMatch(/^sync-/);
    });

    it("handles triggerSync mutation without sinceDays (full sync)", async () => {
      const res = await fetch(`${baseUrl}/api/trpc/sync.triggerSync?batch=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ "0": {} }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveLength(1);
      expect(data[0].result.data.jobId).toMatch(/^sync-/);
    });
  });

  describe("countProviderRecords uses schema-qualified tables", () => {
    it("triggerSync does not fail with 'relation does not exist'", async () => {
      // This catches the bug where raw SQL used unqualified table names
      // (e.g. cardio_activity instead of health.cardio_activity)
      const res = await fetch(`${baseUrl}/api/trpc/sync.triggerSync?batch=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ "0": { providerId: "wahoo", sinceDays: 7 } }),
      });

      const data = await res.json();
      // Should not contain "relation does not exist" error
      if (data[0].error) {
        expect(data[0].error.message).not.toContain("does not exist");
      }
    });
  });
});
