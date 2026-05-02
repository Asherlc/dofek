import { queryCache } from "dofek/lib/cache";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createApp } from "../index.ts";
import type {
  AdaptiveTdeeResult,
  CaloricBalanceRow,
  MacroRatioRow,
  MicronutrientAdequacyRow,
} from "./nutrition-analytics.ts";

/**
 * Integration tests for nutrition-analytics router procedures:
 * - adaptiveTdee: EWMA smoothing + rolling 28-day TDEE estimation
 * - macroRatios: protein/carbs/fat percentages + proteinPerKg
 * - micronutrientAdequacy: RDA percentage calculations from food_entry
 * - caloricBalance: daily calorie balance with rolling average
 */
describe("Nutrition analytics data coverage", () => {
  let server: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let testCtx: TestContext;
  let sessionCookie: string;

  beforeAll(async () => {
    testCtx = await setupTestDatabase();

    const session = await createSession(testCtx.db, TEST_USER_ID);
    sessionCookie = `session=${session.sessionId}`;

    // Set up user profile
    await testCtx.db.execute(
      sql`UPDATE fitness.user_profile
          SET max_hr = 190, resting_hr = 50, ftp = 250, birth_date = '1990-01-01'
          WHERE id = ${TEST_USER_ID}`,
    );

    // Insert providers
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('test_provider', 'Test Provider', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('dofek', 'Dofek App', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );

    // ── Insert 50 days of unnamed food-entry nutrition (needed for adaptiveTdee + macroRatios + caloricBalance) ──
    for (let i = 49; i >= 0; i--) {
      // Vary calories slightly so TDEE estimation has something to work with
      const calories = 2200 + Math.round(Math.sin(i * 0.5) * 200);
      const proteinG = 88 + Math.round(Math.cos(i * 0.3) * 5);
      const carbsG = 250 + Math.round(Math.sin(i * 0.4) * 30);
      const fatG = 80 + Math.round(Math.cos(i * 0.2) * 10);
      await testCtx.db.execute(
        sql`WITH new_entry AS (
              INSERT INTO fitness.food_entry (
                user_id, provider_id, date, external_id, food_name, source_name, confirmed
              ) VALUES (
                ${TEST_USER_ID}, 'dofek',
                CURRENT_DATE - ${i}::int,
                ${`daily-nutrition-${i}`}, NULL, 'Fixture', true
              ) RETURNING id
            )
            INSERT INTO fitness.food_entry_nutrient (food_entry_id, nutrient_id, amount)
            SELECT id, nutrient_id, amount
            FROM new_entry
            CROSS JOIN (VALUES
              ('calories', ${calories}::real),
              ('protein', ${proteinG}::real),
              ('carbohydrate', ${carbsG}::real),
              ('fat', ${fatG}::real)
            ) AS nutrient_values(nutrient_id, amount)
            ON CONFLICT DO NOTHING`,
      );
    }

    // ── Insert 50 days of body_measurement (weight data for adaptiveTdee EWMA + macroRatios proteinPerKg) ──
    // Simulate gradual weight loss from 80kg to ~79kg over 50 days
    for (let i = 49; i >= 0; i--) {
      const weightKg = 80 - (49 - i) * 0.02 + Math.sin(i * 0.7) * 0.3;
      await testCtx.db.execute(
        sql`INSERT INTO fitness.body_measurement (
              recorded_at, provider_id, user_id, weight_kg
            ) VALUES (
              (CURRENT_DATE - ${i}::int)::timestamp + INTERVAL '8 hours',
              'test_provider', ${TEST_USER_ID}, ${weightKg}
            )`,
      );
    }

    // ── Insert daily_metrics with active_energy_kcal and basal_energy_kcal (for caloricBalance) ──
    for (let i = 49; i >= 0; i--) {
      const activeEnergy = 500 + Math.round(Math.sin(i * 0.6) * 150);
      const basalEnergy = 1700 + Math.round(Math.cos(i * 0.3) * 50);
      await testCtx.db.execute(
        sql`INSERT INTO fitness.daily_metrics (
              date, provider_id, user_id, active_energy_kcal, basal_energy_kcal,
              steps
            ) VALUES (
              CURRENT_DATE - ${i}::int,
              'test_provider', ${TEST_USER_ID},
              ${activeEnergy}, ${basalEnergy}, 8000
            ) ON CONFLICT DO NOTHING`,
      );
    }

    // ── Insert food_entry records with micronutrient data (for micronutrientAdequacy) ──
    for (let i = 14; i >= 0; i--) {
      // Breakfast with micronutrients
      await testCtx.db.execute(
        sql`WITH new_entry AS (
              INSERT INTO fitness.food_entry (
                user_id, provider_id, date, meal, food_name, confirmed
              ) VALUES (
                ${TEST_USER_ID}, 'dofek',
                CURRENT_DATE - ${i}::int,
                'breakfast', 'Fortified Oatmeal', true
              ) RETURNING id
            ),
            new_nutrition AS (
              INSERT INTO fitness.food_entry_nutrient (food_entry_id, nutrient_id, amount)
              SELECT id, nutrient_id, amount
              FROM new_entry
              CROSS JOIN (VALUES
                ('calories', 350),
                ('protein', 12),
                ('carbohydrate', 55),
                ('fat', 8),
                ('fiber', 8),
                ('vitamin_a', 450),
                ('vitamin_c', 45),
                ('vitamin_d', 5),
                ('calcium', 350),
                ('iron', 6),
                ('magnesium', 100),
                ('zinc', 4),
                ('potassium', 800),
                ('sodium', 400)
              ) AS nutrient_values(nutrient_id, amount)
            )
            SELECT 1`,
      );

      // Lunch with micronutrients
      await testCtx.db.execute(
        sql`WITH new_entry AS (
              INSERT INTO fitness.food_entry (
                user_id, provider_id, date, meal, food_name, confirmed
              ) VALUES (
                ${TEST_USER_ID}, 'dofek',
                CURRENT_DATE - ${i}::int,
                'lunch', 'Chicken Salad Bowl', true
              ) RETURNING id
            ),
            new_nutrition AS (
              INSERT INTO fitness.food_entry_nutrient (food_entry_id, nutrient_id, amount)
              SELECT id, nutrient_id, amount
              FROM new_entry
              CROSS JOIN (VALUES
                ('calories', 550),
                ('protein', 40),
                ('carbohydrate', 30),
                ('fat', 22),
                ('fiber', 6),
                ('vitamin_a', 300),
                ('vitamin_c', 30),
                ('vitamin_d', 3),
                ('calcium', 250),
                ('iron', 3),
                ('magnesium', 80),
                ('zinc', 5),
                ('potassium', 600),
                ('sodium', 800)
              ) AS nutrient_values(nutrient_id, amount)
            )
            SELECT 1`,
      );

      // Dinner with micronutrients
      await testCtx.db.execute(
        sql`WITH new_entry AS (
              INSERT INTO fitness.food_entry (
                user_id, provider_id, date, meal, food_name, confirmed
              ) VALUES (
                ${TEST_USER_ID}, 'dofek',
                CURRENT_DATE - ${i}::int,
                'dinner', 'Salmon with Vegetables', true
              ) RETURNING id
            ),
            new_nutrition AS (
              INSERT INTO fitness.food_entry_nutrient (food_entry_id, nutrient_id, amount)
              SELECT id, nutrient_id, amount
              FROM new_entry
              CROSS JOIN (VALUES
                ('calories', 600),
                ('protein', 45),
                ('carbohydrate', 35),
                ('fat', 28),
                ('fiber', 7),
                ('vitamin_a', 200),
                ('vitamin_c', 25),
                ('vitamin_d', 8),
                ('calcium', 300),
                ('iron', 2),
                ('magnesium', 120),
                ('zinc', 3),
                ('potassium', 900),
                ('sodium', 600)
              ) AS nutrient_values(nutrient_id, amount)
            )
            SELECT 1`,
      );

      // An unconfirmed entry that should be excluded from micronutrient calculations
      if (i === 5) {
        await testCtx.db.execute(
          sql`WITH new_entry AS (
                INSERT INTO fitness.food_entry (
                  user_id, provider_id, date, meal, food_name, confirmed
                ) VALUES (
                  ${TEST_USER_ID}, 'dofek',
                  CURRENT_DATE - ${i}::int,
                  'snack', 'Unconfirmed Snack', false
              ) RETURNING id
            ),
            new_nutrition AS (
                INSERT INTO fitness.food_entry_nutrient (food_entry_id, nutrient_id, amount)
                SELECT id, nutrient_id, amount
                FROM new_entry
                CROSS JOIN (VALUES
                  ('calories', 200),
                  ('protein', 10),
                  ('carbohydrate', 25),
                  ('fat', 8),
                  ('vitamin_c', 999),
                  ('calcium', 999)
                ) AS nutrient_values(nutrient_id, amount)
              )
              SELECT 1`,
        );
      }
    }

    // ── Refresh materialized views ──
    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.v_daily_metrics`);
    await testCtx.db.execute(
      sql`REFRESH MATERIALIZED VIEW CONCURRENTLY fitness.v_body_measurement`,
    );

    // Start server
    const app = createApp(testCtx.db);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  }, 180_000);

  afterAll(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    await testCtx?.cleanup();
  });

  /** POST a tRPC query and return parsed response data */
  async function query<T = unknown>(path: string, input: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(`${baseUrl}/api/trpc/${path}?batch=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify({ "0": input }),
    });
    const data = await res.json();
    const first: { result?: { data?: T }; error?: { message: string } } = data[0];
    if (first?.error) {
      throw new Error(`${path} error: ${JSON.stringify(first.error)}`);
    }
    return first?.result?.data;
  }

  // ══════════════════════════════════════════════════════════════
  // adaptiveTdee — EWMA smoothing + rolling 28-day TDEE estimation
  // ══════════════════════════════════════════════════════════════
  describe("adaptiveTdee", () => {
    it("returns TDEE estimate with smoothed weight data from 50 days of nutrition + weight", async () => {
      const result = await query<AdaptiveTdeeResult>("nutritionAnalytics.adaptiveTdee", {
        days: 90,
      });

      // Should have daily data for all 50 days of nutrition data
      expect(result.dailyData.length).toBeGreaterThanOrEqual(40);

      // With 50 days of data and weight measurements, TDEE should be estimated
      expect(result.estimatedTdee).not.toBeNull();
      if (result.estimatedTdee != null) {
        // TDEE should be a reasonable value (1500-4000 kcal/day)
        expect(result.estimatedTdee).toBeGreaterThan(1500);
        expect(result.estimatedTdee).toBeLessThan(4000);
      }

      // Should have data points from rolling windows
      expect(result.dataPoints).toBeGreaterThan(0);

      // Confidence should be > 0 with 50 days of data and weight
      expect(result.confidence).toBeGreaterThan(0);
    });

    it("applies EWMA smoothing to weight measurements", async () => {
      const result = await query<AdaptiveTdeeResult>("nutritionAnalytics.adaptiveTdee", {
        days: 90,
      });

      const daysWithWeight = result.dailyData.filter((d) => d.weightKg != null);
      const daysWithSmoothedWeight = result.dailyData.filter((d) => d.smoothedWeight != null);

      // We inserted weight for all 50 days
      expect(daysWithWeight.length).toBeGreaterThanOrEqual(40);
      // Smoothed weight should propagate forward from first weight measurement
      expect(daysWithSmoothedWeight.length).toBeGreaterThanOrEqual(daysWithWeight.length);

      // Smoothed weight should differ from raw weight (EWMA dampens fluctuations)
      let smoothedDiffers = false;
      for (const day of result.dailyData) {
        if (day.weightKg != null && day.smoothedWeight != null) {
          if (Math.abs(day.weightKg - day.smoothedWeight) > 0.01) {
            smoothedDiffers = true;
            break;
          }
        }
      }
      // After the first point, EWMA should differ from raw
      expect(smoothedDiffers).toBe(true);
    });

    it("populates estimatedTdee in daily data after window warmup", async () => {
      const result = await query<AdaptiveTdeeResult>("nutritionAnalytics.adaptiveTdee", {
        days: 90,
      });

      const daysWithTdee = result.dailyData.filter((d) => d.estimatedTdee != null);
      // TDEE estimation starts after 28-day window, so with 50 days we should have ~22 estimates
      expect(daysWithTdee.length).toBeGreaterThan(0);

      // The first 28 days should NOT have TDEE estimates
      for (let i = 0; i < Math.min(28, result.dailyData.length); i++) {
        const day = result.dailyData[i];
        if (day) {
          expect(day.estimatedTdee).toBeNull();
        }
      }

      // Each TDEE estimate should be reasonable
      for (const day of daysWithTdee) {
        if (day.estimatedTdee != null) {
          expect(day.estimatedTdee).toBeGreaterThan(1000);
          expect(day.estimatedTdee).toBeLessThan(5000);
        }
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // macroRatios — protein/carbs/fat percentages + proteinPerKg
  // ══════════════════════════════════════════════════════════════
  describe("macroRatios", () => {
    it("returns daily macro percentage breakdown", async () => {
      const result = await query<MacroRatioRow[]>("nutritionAnalytics.macroRatios", { days: 60 });

      // Should have rows for our 50 days of nutrition data
      expect(result.length).toBeGreaterThanOrEqual(40);

      for (const row of result) {
        expect(row.date).toBeTruthy();

        // Percentages should be reasonable and roughly sum to 100
        expect(row.proteinPct).toBeGreaterThan(0);
        expect(row.carbsPct).toBeGreaterThan(0);
        expect(row.fatPct).toBeGreaterThan(0);

        const total = row.proteinPct + row.carbsPct + row.fatPct;
        expect(total).toBeGreaterThan(95);
        expect(total).toBeLessThan(105);
      }
    });

    it("computes proteinPerKg using latest body weight", async () => {
      const result = await query<MacroRatioRow[]>("nutritionAnalytics.macroRatios", { days: 60 });

      // With body measurements inserted, proteinPerKg should be computed
      const rowsWithProteinPerKg = result.filter((r) => r.proteinPerKg != null);
      expect(rowsWithProteinPerKg.length).toBeGreaterThan(0);

      for (const row of rowsWithProteinPerKg) {
        if (row.proteinPerKg != null) {
          // With daily nutrition plus itemized food rows, expect a plausible g/kg range.
          expect(row.proteinPerKg).toBeGreaterThan(1.0);
          expect(row.proteinPerKg).toBeLessThan(2.5);
        }
      }
    });

    it("returns results sorted by date ascending", async () => {
      const result = await query<MacroRatioRow[]>("nutritionAnalytics.macroRatios", { days: 60 });

      for (let i = 1; i < result.length; i++) {
        const prev = result[i - 1];
        const curr = result[i];
        if (prev && curr) {
          expect(prev.date <= curr.date).toBe(true);
        }
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // micronutrientAdequacy — RDA percentage calculations
  // ══════════════════════════════════════════════════════════════
  describe("micronutrientAdequacy", () => {
    it("returns RDA comparisons for tracked micronutrients", async () => {
      await queryCache.invalidateAll();
      const result = await query<MicronutrientAdequacyRow[]>(
        "nutritionAnalytics.micronutrientAdequacy",
        { days: 30 },
      );

      // We inserted food entries with vitamin_a, vitamin_c, vitamin_d, calcium,
      // iron, magnesium, zinc, potassium, sodium, fiber
      expect(result.length).toBeGreaterThanOrEqual(8);

      // Verify specific nutrients we inserted
      const vitaminC = result.find((r) => r.nutrient === "Vitamin C");
      expect(vitaminC).toBeDefined();
      if (vitaminC) {
        expect(vitaminC.unit).toBe("mg");
        expect(vitaminC.rda).toBe(90);
        // We inserted 45 + 30 + 25 = 100mg/day vitamin C
        expect(vitaminC.avgIntake).toBeGreaterThan(80);
        expect(vitaminC.percentRda).toBeGreaterThan(80);
        expect(vitaminC.daysTracked).toBeGreaterThanOrEqual(10);
      }

      const calcium = result.find((r) => r.nutrient === "Calcium");
      expect(calcium).toBeDefined();
      if (calcium) {
        expect(calcium.unit).toBe("mg");
        expect(calcium.rda).toBe(1000);
        // We inserted 350 + 250 + 300 = 900mg/day
        expect(calcium.avgIntake).toBeGreaterThan(700);
        expect(calcium.daysTracked).toBeGreaterThanOrEqual(10);
      }

      const iron = result.find((r) => r.nutrient === "Iron");
      expect(iron).toBeDefined();
      if (iron) {
        expect(iron.rda).toBe(8);
        // 6 + 3 + 2 = 11mg/day
        expect(iron.avgIntake).toBeGreaterThan(8);
        expect(iron.percentRda).toBeGreaterThan(100);
      }

      const fiber = result.find((r) => r.nutrient === "Fiber");
      expect(fiber).toBeDefined();
      if (fiber) {
        expect(fiber.rda).toBe(38);
        // 8 + 6 + 7 = 21g/day
        expect(fiber.avgIntake).toBeGreaterThan(15);
      }
    });

    it("only counts confirmed food entries", async () => {
      const result = await query<MicronutrientAdequacyRow[]>(
        "nutritionAnalytics.micronutrientAdequacy",
        { days: 30 },
      );

      // The unconfirmed entry had 999mg vitamin C — if it were included,
      // avgIntake would be significantly higher
      const vitaminC = result.find((r) => r.nutrient === "Vitamin C");
      if (vitaminC) {
        // Average should be around 100mg/day (from 3 confirmed meals), not inflated by 999
        expect(vitaminC.avgIntake).toBeLessThan(200);
      }
    });

    it("excludes nutrients with zero tracked days", async () => {
      const result = await query<MicronutrientAdequacyRow[]>(
        "nutritionAnalytics.micronutrientAdequacy",
        { days: 30 },
      );

      // We did not insert vitamin_b1, vitamin_b2, etc. so those should be filtered out
      for (const row of result) {
        expect(row.daysTracked).toBeGreaterThan(0);
        expect(row.avgIntake).toBeGreaterThan(0);
      }

      // Nutrients we did NOT insert should not appear
      const biotin = result.find((r) => r.nutrient === "Biotin (B7)");
      expect(biotin).toBeUndefined();

      const vitB12 = result.find((r) => r.nutrient === "Vitamin B12");
      expect(vitB12).toBeUndefined();
    });
  });

  // ══════════════════════════════════════════════════════════════
  // caloricBalance — daily calorie balance with rolling average
  // ══════════════════════════════════════════════════════════════
  describe("caloricBalance", () => {
    it("returns daily caloric balance with expenditure breakdown", async () => {
      await queryCache.invalidateAll();
      const result = await query<CaloricBalanceRow[]>("nutritionAnalytics.caloricBalance", {
        days: 45,
      });

      // With 50 days of both derived daily nutrition and daily_metrics data
      expect(result.length).toBeGreaterThan(0);

      for (const row of result) {
        expect(row.date).toBeTruthy();
        expect(row.caloriesIn).toBeGreaterThan(0);
        expect(row.basalEnergy).toBeGreaterThan(0);
        expect(row.activeEnergy).toBeGreaterThanOrEqual(0);

        // totalExpenditure = activeEnergy + basalEnergy
        expect(row.totalExpenditure).toBe(row.activeEnergy + row.basalEnergy);

        // balance = caloriesIn - totalExpenditure
        expect(row.balance).toBe(row.caloriesIn - row.totalExpenditure);
      }
    });

    it("computes rolling 7-day average balance", async () => {
      const result = await query<CaloricBalanceRow[]>("nutritionAnalytics.caloricBalance", {
        days: 45,
      });

      // rollingAvgBalance should be populated
      const rowsWithRolling = result.filter((r) => r.rollingAvgBalance != null);
      expect(rowsWithRolling.length).toBeGreaterThan(0);

      // Rolling average should be a smoothed version of daily balance
      for (const row of rowsWithRolling) {
        if (row.rollingAvgBalance != null) {
          // Should be a reasonable number (not NaN or extreme)
          expect(Number.isFinite(row.rollingAvgBalance)).toBe(true);
        }
      }
    });

    it("returns results sorted by date ascending", async () => {
      const result = await query<CaloricBalanceRow[]>("nutritionAnalytics.caloricBalance", {
        days: 45,
      });

      for (let i = 1; i < result.length; i++) {
        const prev = result[i - 1];
        const curr = result[i];
        if (prev && curr) {
          expect(prev.date <= curr.date).toBe(true);
        }
      }
    });
  });
});
