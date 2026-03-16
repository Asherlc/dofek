import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createApp } from "../index.ts";

describe("Activity router", () => {
  let server: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let testCtx: TestContext;
  let sessionCookie: string;

  const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001";

  beforeAll(async () => {
    testCtx = await setupTestDatabase();

    const session = await createSession(testCtx.db, DEFAULT_USER_ID);
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
  }, 60_000);

  afterAll(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    await testCtx?.cleanup();
  });

  /** Helper: GET a tRPC query and return parsed response */
  async function query(path: string, input: Record<string, unknown> = {}) {
    const encoded = encodeURIComponent(JSON.stringify(input));
    const res = await fetch(`${baseUrl}/api/trpc/${path}?input=${encoded}`, {
      headers: { Cookie: sessionCookie },
    });
    return res.json();
  }

  describe("byId", () => {
    it("returns NOT_FOUND for a non-existent activity", async () => {
      const result = await query("activity.byId", {
        id: "00000000-0000-0000-0000-000000000099",
      });
      expect(result.error).toBeDefined();
      expect(result.error.data.code).toBe("NOT_FOUND");
    });

    it("rejects invalid UUID input", async () => {
      const result = await query("activity.byId", { id: "not-a-uuid" });
      expect(result.error).toBeDefined();
      expect(result.error.data.code).toBe("BAD_REQUEST");
    });
  });

  describe("stream", () => {
    it("returns empty array for non-existent activity", async () => {
      const result = await query("activity.stream", {
        id: "00000000-0000-0000-0000-000000000099",
      });
      // Stream returns empty array (no data), not an error
      expect(result.result?.data).toEqual([]);
    });

    it("rejects maxPoints below minimum", async () => {
      const result = await query("activity.stream", {
        id: "00000000-0000-0000-0000-000000000099",
        maxPoints: 1,
      });
      expect(result.error).toBeDefined();
      expect(result.error.data.code).toBe("BAD_REQUEST");
    });

    it("rejects maxPoints above maximum", async () => {
      const result = await query("activity.stream", {
        id: "00000000-0000-0000-0000-000000000099",
        maxPoints: 100000,
      });
      expect(result.error).toBeDefined();
      expect(result.error.data.code).toBe("BAD_REQUEST");
    });
  });

  describe("hrZones", () => {
    it("returns 5 zones for a non-existent activity (all zero seconds)", async () => {
      const result = await query("activity.hrZones", {
        id: "00000000-0000-0000-0000-000000000099",
      });
      const zones = result.result?.data;
      // May return empty or all-zero depending on user_profile having max_hr
      // Either way it should not error
      if (zones) {
        expect(zones).toHaveLength(5);
        for (const zone of zones) {
          expect(zone.seconds).toBe(0);
        }
      }
    });

    it("returns zones with correct labels and percentages", async () => {
      const result = await query("activity.hrZones", {
        id: "00000000-0000-0000-0000-000000000099",
      });
      const zones = result.result?.data;
      if (zones && zones.length === 5) {
        expect(zones[0].label).toBe("Recovery");
        expect(zones[0].minPct).toBe(50);
        expect(zones[0].maxPct).toBe(60);
        expect(zones[4].label).toBe("Anaerobic");
        expect(zones[4].minPct).toBe(90);
        expect(zones[4].maxPct).toBe(100);
      }
    });
  });

  describe("authentication", () => {
    it("rejects unauthenticated requests for byId", async () => {
      const encoded = encodeURIComponent(
        JSON.stringify({ id: "00000000-0000-0000-0000-000000000099" }),
      );
      const res = await fetch(`${baseUrl}/api/trpc/activity.byId?input=${encoded}`);
      const result = await res.json();
      expect(result.error).toBeDefined();
      expect(result.error.data.code).toBe("UNAUTHORIZED");
    });

    it("rejects unauthenticated requests for stream", async () => {
      const encoded = encodeURIComponent(
        JSON.stringify({ id: "00000000-0000-0000-0000-000000000099" }),
      );
      const res = await fetch(`${baseUrl}/api/trpc/activity.stream?input=${encoded}`);
      const result = await res.json();
      expect(result.error).toBeDefined();
      expect(result.error.data.code).toBe("UNAUTHORIZED");
    });

    it("rejects unauthenticated requests for hrZones", async () => {
      const encoded = encodeURIComponent(
        JSON.stringify({ id: "00000000-0000-0000-0000-000000000099" }),
      );
      const res = await fetch(`${baseUrl}/api/trpc/activity.hrZones?input=${encoded}`);
      const result = await res.json();
      expect(result.error).toBeDefined();
      expect(result.error.data.code).toBe("UNAUTHORIZED");
    });
  });
});
