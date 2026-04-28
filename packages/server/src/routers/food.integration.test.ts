import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createApp } from "../index.ts";

describe("Food router", () => {
  const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";
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

  describe("create mutation", () => {
    it("creates a food entry and returns it", async () => {
      const result = await mutate("food.create", {
        date: "2025-01-15",
        meal: "breakfast",
        foodName: "Oatmeal with Berries",
        calories: 350,
        proteinG: 12,
        carbsG: 55,
        fatG: 8,
        fiberG: 6,
      });

      expect(result.result.data).toBeDefined();
      const entry = result.result.data;
      expect(entry.id).toBeDefined();
      expect(entry.food_name).toBe("Oatmeal with Berries");
      expect(entry.calories).toBe(350);
      expect(entry.provider_id).toBe("dofek");
      expect(entry.meal).toBe("breakfast");
    });
  });

  describe("quickAdd mutation", () => {
    it("creates a simplified food entry with just calories", async () => {
      const result = await mutate("food.quickAdd", {
        date: "2025-01-15",
        meal: "snack",
        foodName: "Protein Bar",
        calories: 200,
        proteinG: 20,
      });

      expect(result.result.data).toBeDefined();
      const entry = result.result.data;
      expect(entry.food_name).toBe("Protein Bar");
      expect(entry.calories).toBe(200);
      expect(entry.protein_g).toBe(20);
    });
  });

  describe("byDate query", () => {
    it("returns entries grouped by meal for a given date", async () => {
      const result = await query("food.byDate", { date: "2025-01-15" });

      expect(result.result.data).toBeDefined();
      const data = result.result.data;
      // Should contain the entries we created above
      expect(data.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("list query", () => {
    it("returns food entries for a date range", async () => {
      const result = await query("food.list", {
        startDate: "2025-01-01",
        endDate: "2025-01-31",
      });

      expect(result.result.data).toBeDefined();
      expect(result.result.data.length).toBeGreaterThanOrEqual(2);
    });

    it("filters by meal when provided", async () => {
      const result = await query("food.list", {
        startDate: "2025-01-01",
        endDate: "2025-01-31",
        meal: "breakfast",
      });

      expect(result.result.data).toBeDefined();
      for (const entry of result.result.data) {
        expect(entry.meal).toBe("breakfast");
      }
    });
  });

  describe("dailyTotals query", () => {
    it("returns aggregated daily macro totals", async () => {
      const result = await query("food.dailyTotals", { days: 30 });

      expect(result.result.data).toBeDefined();
      // We have entries for 2025-01-15
      const data: Array<{
        date: string;
        calories: number;
        protein_g: number;
      }> = result.result.data;
      // With an empty-ish DB + our inserts, we should get at least one day
      expect(Array.isArray(data)).toBe(true);
    });
  });

  describe("healthKitWriteBackEntries query", () => {
    it("returns only confirmed Dofek-owned food entries for Apple Health write-back", async () => {
      const uniqueSuffix = crypto.randomUUID();
      const direct = await mutate("food.create", {
        date: "2025-03-10",
        meal: "lunch",
        foodName: "Direct Dofek Meal",
        calories: 610,
        proteinG: 42,
        carbsG: 58,
        fatG: 18,
      });

      await testCtx.db.execute(sql`
        INSERT INTO fitness.provider (id, name, user_id)
        VALUES ('cronometer', 'Cronometer', ${TEST_USER_ID})
        ON CONFLICT (id) DO NOTHING
      `);
      await testCtx.db.execute(sql`
        WITH synced_entry AS (
          INSERT INTO fitness.food_entry (
            user_id, provider_id, external_id, date, meal, food_name, confirmed
          )
          VALUES (
            ${TEST_USER_ID}, 'cronometer', ${`cron-${uniqueSuffix}`}, '2025-03-10'::date,
            'lunch', 'Synced Cronometer Meal', true
          )
          RETURNING id
        )
        INSERT INTO fitness.food_entry_nutrient (food_entry_id, nutrient_id, amount)
        SELECT id, nutrient_id, amount
        FROM synced_entry
        CROSS JOIN (VALUES
          ('calories', 700::real),
          ('protein', 50::real),
          ('carbohydrate', 60::real),
          ('fat', 20::real)
        ) AS nutrient_values(nutrient_id, amount)
      `);
      await testCtx.db.execute(sql`
        WITH unconfirmed_entry AS (
          INSERT INTO fitness.food_entry (
            user_id, provider_id, external_id, date, meal, food_name, confirmed
          )
          VALUES (
            ${TEST_USER_ID}, 'dofek', ${`draft-${uniqueSuffix}`}, '2025-03-10'::date,
            'snack', 'Unconfirmed Dofek Meal', false
          )
          RETURNING id
        )
        INSERT INTO fitness.food_entry_nutrient (food_entry_id, nutrient_id, amount)
        SELECT id, nutrient_id, amount
        FROM unconfirmed_entry
        CROSS JOIN (VALUES
          ('calories', 100::real),
          ('protein', 5::real),
          ('carbohydrate', 10::real),
          ('fat', 2::real)
        ) AS nutrient_values(nutrient_id, amount)
      `);

      const result = await query("food.healthKitWriteBackEntries", {
        startDate: "2025-03-10",
        endDate: "2025-03-10",
      });

      expect(result.result.data).toEqual([
        {
          id: direct.result.data.id,
          date: "2025-03-10",
          food_name: "Direct Dofek Meal",
          calories: 610,
          protein_g: 42,
          carbs_g: 58,
          fat_g: 18,
        },
      ]);
    });
  });

  describe("update mutation", () => {
    let entryId: string;

    beforeAll(async () => {
      // Create an entry to update
      const result = await mutate("food.create", {
        date: "2025-02-01",
        meal: "lunch",
        foodName: "Chicken Salad",
        calories: 400,
        proteinG: 35,
      });
      entryId = result.result.data.id;
    });

    it("updates specific fields of a food entry", async () => {
      const result = await mutate("food.update", {
        id: entryId,
        calories: 450,
        foodName: "Grilled Chicken Salad",
      });

      expect(result.result.data).toBeDefined();
      const entry = result.result.data;
      expect(entry.calories).toBe(450);
      expect(entry.food_name).toBe("Grilled Chicken Salad");
    });
  });

  describe("delete mutation", () => {
    let entryId: string;

    beforeAll(async () => {
      const result = await mutate("food.create", {
        date: "2025-02-01",
        meal: "dinner",
        foodName: "Pizza Slice",
        calories: 300,
      });
      entryId = result.result.data.id;
    });

    it("deletes a food entry", async () => {
      const result = await mutate("food.delete", { id: entryId });

      expect(result.result.data).toBeDefined();
      expect(result.result.data.success).toBe(true);

      // Verify it's gone
      const entries = await query("food.byDate", { date: "2025-02-01" });
      const remaining: Array<{ id: string }> = entries.result.data;
      const found = remaining.find((e) => e.id === entryId);
      expect(found).toBeUndefined();
    });

    it("deletes one entry without affecting another entry on the same day", async () => {
      const first = await mutate("food.create", {
        date: "2025-02-03",
        meal: "lunch",
        foodName: "First Entry",
        calories: 225,
      });
      const second = await mutate("food.create", {
        date: "2025-02-03",
        meal: "lunch",
        foodName: "Second Entry",
        calories: 225,
      });
      const firstId: string = first.result.data.id;
      const secondId: string = second.result.data.id;

      const deleteResult = await mutate("food.delete", { id: firstId });
      expect(deleteResult.result.data.success).toBe(true);

      const entries = await query("food.byDate", { date: "2025-02-03" });
      const remaining: Array<{ id: string }> = entries.result.data;
      expect(remaining.some((entry) => entry.id === firstId)).toBe(false);
      expect(remaining.some((entry) => entry.id === secondId)).toBe(true);
    });

    it("cascades delete to food_entry_nutrient rows", async () => {
      const created = await mutate("food.create", {
        date: "2025-02-04",
        meal: "lunch",
        foodName: "Cascade Test Meal",
        calories: 420,
        proteinG: 30,
      });
      const cascadeEntryId: string = created.result.data.id;

      const beforeRows = await testCtx.db.execute<{ count: string }>(
        sql`SELECT COUNT(*)::text AS count
            FROM fitness.food_entry_nutrient
            WHERE food_entry_id = ${cascadeEntryId}::uuid`,
      );
      expect(beforeRows[0]?.count).toBe("2");

      const deleted = await mutate("food.delete", { id: cascadeEntryId });
      expect(deleted.result.data.success).toBe(true);

      const afterRows = await testCtx.db.execute<{ count: string }>(
        sql`SELECT COUNT(*)::text AS count
            FROM fitness.food_entry_nutrient
            WHERE food_entry_id = ${cascadeEntryId}::uuid`,
      );
      expect(afterRows[0]?.count).toBe("0");
    });
  });

  describe("search query", () => {
    it("finds foods matching a query string", async () => {
      const result = await query("food.search", { query: "Oatmeal" });

      expect(result.result.data).toBeDefined();
      const data: Array<{ food_name: string }> = result.result.data;
      expect(data.length).toBeGreaterThanOrEqual(1);
      expect(data[0]?.food_name).toContain("Oatmeal");
    });

    it("respects the limit parameter", async () => {
      const result = await query("food.search", { query: "Chicken", limit: 1 });

      expect(result.result.data).toBeDefined();
      expect(result.result.data.length).toBeLessThanOrEqual(1);
    });
  });
});
