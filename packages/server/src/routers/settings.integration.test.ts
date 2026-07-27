import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createApp } from "../index.ts";
import { makeMockSensorStore } from "./test-helpers.ts";

const SETTINGS_TEST_USER_ID = "00000000-0000-0000-0000-0000000000f1";

describe("Settings router", () => {
  let server: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let testCtx: TestContext;
  let sessionCookie: string;

  beforeAll(async () => {
    testCtx = await setupTestDatabase();
    await testCtx.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name)
          VALUES (${SETTINGS_TEST_USER_ID}, 'Settings Test User')
          ON CONFLICT (id) DO NOTHING`,
    );
    await testCtx.db.execute(
      sql`INSERT INTO fitness.user_billing (user_id, paid_grant_reason)
          VALUES (${SETTINGS_TEST_USER_ID}, 'existing_account')
          ON CONFLICT (user_id) DO NOTHING`,
    );

    const session = await createSession(testCtx.db, SETTINGS_TEST_USER_ID);
    sessionCookie = `session=${session.sessionId}`;

    const app = createApp(testCtx.db, makeMockSensorStore());
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
    it("sets a known setting and gets it back", async () => {
      await mutate("settings.set", { key: "unitSystem", value: "imperial" });

      const result = await query("settings.get", { key: "unitSystem" });
      expect(result.result.data).toBeDefined();
      expect(result.result.data.key).toBe("unitSystem");
      expect(result.result.data.value).toBe("imperial");
    });

    it.each([
      { key: "unitSystem", value: "kelvin" },
      { key: "dashboardLayout", value: { order: [], hidden: [], collapsed: "invalid" } },
      { key: "whoop.wearLocation", value: "ankle" },
      { key: "primaryGoal", value: "loseWeight" },
      { key: "unknownSetting", value: true },
      {
        key: "medicationReminders",
        value: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            medicationName: "",
            localTime: "08:30",
            enabled: true,
          },
        ],
      },
      {
        key: "medicationReminders",
        value: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            medicationName: "Vitamin D3",
            localTime: "8:30",
            enabled: true,
          },
        ],
      },
    ])("rejects malformed or unknown setting $key", async (input) => {
      const result = await mutate("settings.set", input);

      expect(result.error.data.code).toBe("BAD_REQUEST");
    });

    it("sets medication reminders and gets them back", async () => {
      const reminders = [
        {
          id: "11111111-1111-4111-8111-111111111111",
          medicationName: "Vitamin D3",
          localTime: "08:30",
          enabled: true,
        },
      ];

      await mutate("settings.set", { key: "medicationReminders", value: reminders });

      const result = await query("settings.get", { key: "medicationReminders" });
      expect(result.result.data).toEqual({
        key: "medicationReminders",
        value: reminders,
      });
    });

    it("sets and gets primaryGoal", async () => {
      await mutate("settings.set", { key: "primaryGoal", value: "sleepConsistency" });

      const result = await query("settings.get", { key: "primaryGoal" });
      expect(result.result.data).toEqual({
        key: "primaryGoal",
        value: "sleepConsistency",
      });
    });

    it("returns the updated primaryGoal after set, not a stale cached value", async () => {
      await mutate("settings.set", { key: "primaryGoal", value: "racePreparation" });
      const first = await query("settings.get", { key: "primaryGoal" });
      expect(first.result.data.value).toBe("racePreparation");

      await mutate("settings.set", { key: "primaryGoal", value: "weightTrend" });
      const second = await query("settings.get", { key: "primaryGoal" });
      expect(second.result.data.value).toBe("weightTrend");
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
      await mutate("settings.set", { key: "unitSystem", value: "metric" });
      await mutate("settings.set", { key: "unitSystem", value: "imperial" });

      const result = await query("settings.get", { key: "unitSystem" });
      expect(result.result.data.value).toBe("imperial");
    });
  });

  describe("cache invalidation on set", () => {
    it("returns the updated value after set, not the stale cached value", async () => {
      // 1. Set initial value
      await mutate("settings.set", { key: "unitSystem", value: "metric" });

      // 2. Read it — populates the server-side cache
      const first = await query("settings.get", { key: "unitSystem" });
      expect(first.result.data.value).toBe("metric");

      // 3. Update the value
      await mutate("settings.set", { key: "unitSystem", value: "imperial" });

      // 4. Read again — should return "imperial", not stale "metric"
      const second = await query("settings.get", { key: "unitSystem" });
      expect(second.result.data.value).toBe("imperial");
    });
  });

  describe("getAll", () => {
    it("returns all settings", async () => {
      // Ensure we have at least two settings from previous tests
      await mutate("settings.set", { key: "unitSystem", value: "metric" });
      await mutate("settings.set", { key: "whoop.wearLocation", value: "wrist" });

      const result = await query("settings.getAll");
      expect(result.result.data).toBeDefined();
      const settings: Array<{ key: string; value: unknown }> = result.result.data;
      expect(settings.length).toBeGreaterThanOrEqual(2);

      const keys = settings.map((s) => s.key);
      expect(keys).toContain("unitSystem");
      expect(keys).toContain("whoop.wearLocation");
    });
  });

  describe("provider guide", () => {
    it("stores provider guide dismissal through the API", async () => {
      const initialStatus = await query("providerGuide.status");
      expect(initialStatus.result.data).toEqual({ dismissed: false });

      const dismissResult = await mutate("providerGuide.dismiss");
      expect(dismissResult.result.data).toEqual({ dismissed: true });

      const dismissedStatus = await query("providerGuide.status");
      expect(dismissedStatus.result.data).toEqual({ dismissed: true });
    });
  });
});
