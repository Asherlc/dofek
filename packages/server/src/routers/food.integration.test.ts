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

    it("deletes an entry when its nutrition data is shared by another entry", async () => {
      await testCtx.db.execute(
        sql`INSERT INTO fitness.provider (id, name, user_id)
            VALUES ('dofek', 'Dofek App', ${TEST_USER_ID})
            ON CONFLICT (id) DO NOTHING`,
      );
      const nutritionRows = await testCtx.db.execute<{ id: string }>(
        sql`INSERT INTO fitness.nutrition_data (calories) VALUES (225) RETURNING id`,
      );
      const nutritionDataId = nutritionRows[0]?.id;
      expect(nutritionDataId).toBeDefined();

      const firstRows = await testCtx.db.execute<{ id: string }>(
        sql`INSERT INTO fitness.food_entry (
              user_id, provider_id, date, meal, food_name, nutrition_data_id, confirmed
            ) VALUES (
              ${TEST_USER_ID}, 'dofek', '2025-02-03'::date, 'lunch', 'Shared Nutrition First',
              ${nutritionDataId}::uuid, true
            )
            RETURNING id`,
      );
      const secondRows = await testCtx.db.execute<{ id: string }>(
        sql`INSERT INTO fitness.food_entry (
              user_id, provider_id, date, meal, food_name, nutrition_data_id, confirmed
            ) VALUES (
              ${TEST_USER_ID}, 'dofek', '2025-02-03'::date, 'lunch', 'Shared Nutrition Second',
              ${nutritionDataId}::uuid, true
            )
            RETURNING id`,
      );
      const firstId = firstRows[0]?.id;
      const secondId = secondRows[0]?.id;
      expect(firstId).toBeDefined();
      expect(secondId).toBeDefined();

      const deleteResult = await mutate("food.delete", { id: firstId });
      expect(deleteResult.result.data).toBeDefined();
      expect(deleteResult.result.data.success).toBe(true);

      const entries = await query("food.byDate", { date: "2025-02-03" });
      const remaining: Array<{ id: string }> = entries.result.data;
      expect(remaining.some((entry) => entry.id === firstId)).toBe(false);
      expect(remaining.some((entry) => entry.id === secondId)).toBe(true);

      const sharedNutritionRows = await testCtx.db.execute<{ id: string }>(
        sql`SELECT id FROM fitness.nutrition_data WHERE id = ${nutritionDataId}::uuid`,
      );
      expect(sharedNutritionRows).toHaveLength(1);
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
