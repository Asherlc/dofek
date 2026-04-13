import { TEST_USER_ID } from "dofek/db/schema";
import { sql } from "drizzle-orm";
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

  describe("cache invalidation on set", () => {
    it("returns the updated value after set, not the stale cached value", async () => {
      // 1. Set initial value
      await mutate("settings.set", { key: "cacheTest", value: "metric" });

      // 2. Read it — populates the server-side cache
      const first = await query("settings.get", { key: "cacheTest" });
      expect(first.result.data.value).toBe("metric");

      // 3. Update the value
      await mutate("settings.set", { key: "cacheTest", value: "imperial" });

      // 4. Read again — should return "imperial", not stale "metric"
      const second = await query("settings.get", { key: "cacheTest" });
      expect(second.result.data.value).toBe("imperial");
    });
  });

  describe("getAll", () => {
    it("returns all settings", async () => {
      // Ensure we have at least two settings from previous tests
      await mutate("settings.set", { key: "allTestA", value: 1 });
      await mutate("settings.set", { key: "allTestB", value: 2 });

      const result = await query("settings.getAll");
      expect(result.result.data).toBeDefined();
      const settings: Array<{ key: string; value: unknown }> = result.result.data;
      expect(settings.length).toBeGreaterThanOrEqual(2);

      const keys = settings.map((s) => s.key);
      expect(keys).toContain("allTestA");
      expect(keys).toContain("allTestB");
    });
  });

  describe("deleteAllUserData", () => {
    it("wipes provider and user-scoped data for the current user", async () => {
      await testCtx.db.execute(
        sql`INSERT INTO fitness.provider (id, name, user_id)
            VALUES ('settings-wipe-provider', 'Settings Wipe Provider', ${TEST_USER_ID})
            ON CONFLICT DO NOTHING`,
      );
      await Promise.all([
        testCtx.db.execute(
          sql`INSERT INTO fitness.activity (id, provider_id, user_id, activity_type, started_at, name)
              VALUES (
                '22222222-2222-2222-2222-222222222222',
                'settings-wipe-provider',
                ${TEST_USER_ID},
                'running',
                '2024-01-15T10:00:00Z',
                'Delete Me'
              )
              ON CONFLICT DO NOTHING`,
        ),
        testCtx.db.execute(
          sql`INSERT INTO fitness.metric_stream (recorded_at, user_id, provider_id, device_id, source_type, channel, activity_id, scalar, vector)
              VALUES (
                '2024-01-15T10:00:00Z',
                ${TEST_USER_ID},
                'settings-wipe-provider',
                NULL,
                'api',
                'heart_rate',
                '22222222-2222-2222-2222-222222222222',
                150,
                NULL
              )`,
        ),
        testCtx.db.execute(
          sql`INSERT INTO fitness.sync_log (provider_id, user_id, data_type, status)
              VALUES ('settings-wipe-provider', ${TEST_USER_ID}, 'activities', 'success')`,
        ),
        testCtx.db.execute(
          sql`INSERT INTO fitness.oauth_token (user_id, provider_id, access_token, expires_at)
              VALUES (${TEST_USER_ID}, 'settings-wipe-provider', 'token-to-delete', '2099-01-01T00:00:00Z')
              ON CONFLICT DO NOTHING`,
        ),
        testCtx.db.execute(
          sql`INSERT INTO fitness.life_events (user_id, label, started_at)
              VALUES (${TEST_USER_ID}, 'Delete event', '2024-01-15')`,
        ),
        testCtx.db.execute(
          sql`INSERT INTO fitness.sport_settings (user_id, sport, effective_from, ftp)
              VALUES (${TEST_USER_ID}, 'running', '2024-01-15', 260)
              ON CONFLICT DO NOTHING`,
        ),
        testCtx.db.execute(
          sql`INSERT INTO fitness.supplement (user_id, name)
              VALUES (${TEST_USER_ID}, 'Delete supplement')
              ON CONFLICT DO NOTHING`,
        ),
        testCtx.db.execute(
          sql`INSERT INTO fitness.user_settings (user_id, key, value)
              VALUES (${TEST_USER_ID}, 'deleteMe', 'true'::jsonb)
              ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value`,
        ),
      ]);

      const mutationResult = await mutate("settings.deleteAllUserData");
      expect(mutationResult.result.data).toEqual({ success: true });

      const [
        activitiesAfter,
        metricsAfter,
        logsAfter,
        tokensAfter,
        eventsAfter,
        sportSettingsAfter,
        supplementsAfter,
        userSettingsAfter,
      ] = await Promise.all([
        testCtx.db.execute<{ count: number }>(
          sql`SELECT count(*)::int AS count FROM fitness.activity WHERE user_id = ${TEST_USER_ID}`,
        ),
        testCtx.db.execute<{ count: number }>(
          sql`SELECT count(*)::int AS count FROM fitness.metric_stream WHERE user_id = ${TEST_USER_ID}`,
        ),
        testCtx.db.execute<{ count: number }>(
          sql`SELECT count(*)::int AS count FROM fitness.sync_log WHERE user_id = ${TEST_USER_ID}`,
        ),
        testCtx.db.execute<{ count: number }>(
          sql`SELECT count(*)::int AS count FROM fitness.oauth_token WHERE user_id = ${TEST_USER_ID}`,
        ),
        testCtx.db.execute<{ count: number }>(
          sql`SELECT count(*)::int AS count FROM fitness.life_events WHERE user_id = ${TEST_USER_ID}`,
        ),
        testCtx.db.execute<{ count: number }>(
          sql`SELECT count(*)::int AS count FROM fitness.sport_settings WHERE user_id = ${TEST_USER_ID}`,
        ),
        testCtx.db.execute<{ count: number }>(
          sql`SELECT count(*)::int AS count FROM fitness.supplement WHERE user_id = ${TEST_USER_ID}`,
        ),
        testCtx.db.execute<{ count: number }>(
          sql`SELECT count(*)::int AS count FROM fitness.user_settings WHERE user_id = ${TEST_USER_ID}`,
        ),
      ]);

      expect(activitiesAfter[0]?.count).toBe(0);
      expect(metricsAfter[0]?.count).toBe(0);
      expect(logsAfter[0]?.count).toBe(0);
      expect(tokensAfter[0]?.count).toBe(0);
      expect(eventsAfter[0]?.count).toBe(0);
      expect(sportSettingsAfter[0]?.count).toBe(0);
      expect(supplementsAfter[0]?.count).toBe(0);
      expect(userSettingsAfter[0]?.count).toBe(0);

      // Session should remain usable after data deletion.
      await mutate("settings.set", { key: "afterDelete", value: true });
      const settingResult = await query("settings.get", { key: "afterDelete" });
      expect(settingResult.result.data.value).toBe(true);
    });
  });
});
