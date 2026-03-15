import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createApp } from "../index.ts";

describe("Settings router", () => {
  let server: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let testCtx: TestContext;
  let sessionCookie: string;

  beforeAll(async () => {
    testCtx = await setupTestDatabase();

    const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001";
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

  /** Helper: POST a tRPC mutation and return parsed response */
  async function mutate(path: string, input: Record<string, unknown> = {}) {
    const res = await fetch(`${baseUrl}/api/trpc/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify(input),
    });
    return res.json();
  }

  /** Helper: GET a tRPC query and return parsed response */
  async function query(path: string, input: Record<string, unknown> = {}) {
    const encoded = encodeURIComponent(JSON.stringify(input));
    const res = await fetch(`${baseUrl}/api/trpc/${path}?input=${encoded}`, {
      headers: { Cookie: sessionCookie },
    });
    return res.json();
  }

  describe("set and get", () => {
    it("sets a setting and gets it back", async () => {
      await mutate("settings.set", { key: "testSetting", value: 42 });

      const result = await query("settings.get", { key: "testSetting" });
      expect(result.result.data).toBeDefined();
      expect(result.result.data.key).toBe("testSetting");
      expect(result.result.data.value).toBe(42);
    });
  });

  describe("get non-existent", () => {
    it("returns null for a non-existent setting", async () => {
      const result = await query("settings.get", { key: "nonExistentKey" });
      expect(result.result.data).toBeNull();
    });
  });

  describe("upsert", () => {
    it("overwrites an existing value", async () => {
      await mutate("settings.set", { key: "upsertTest", value: "first" });
      await mutate("settings.set", { key: "upsertTest", value: "second" });

      const result = await query("settings.get", { key: "upsertTest" });
      expect(result.result.data.value).toBe("second");
    });
  });

  describe("getAll", () => {
    it("returns all settings", async () => {
      // Ensure we have at least two settings from previous tests
      await mutate("settings.set", { key: "allTestA", value: 1 });
      await mutate("settings.set", { key: "allTestB", value: 2 });

      const result = await query("settings.getAll");
      expect(result.result.data).toBeDefined();
      const settings = result.result.data as Array<{ key: string; value: unknown }>;
      expect(settings.length).toBeGreaterThanOrEqual(2);

      const keys = settings.map((s) => s.key);
      expect(keys).toContain("allTestA");
      expect(keys).toContain("allTestB");
    });
  });
});
