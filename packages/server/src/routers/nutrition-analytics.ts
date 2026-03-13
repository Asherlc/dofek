import { sql } from "drizzle-orm";
import { z } from "zod";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

// ── RDA Reference Data ───────────────────────────────────────────────
// Recommended Dietary Allowances for adult males (19-50). These are static
// reference values from the National Institutes of Health Office of Dietary
// Supplements. A more complete system would account for age/sex/pregnancy.

interface RecommendedDailyAllowance {
  nutrient: string;
  column: string;
  rda: number;
  unit: string;
}

const RECOMMENDED_DAILY_ALLOWANCES: RecommendedDailyAllowance[] = [
  { nutrient: "Vitamin A", column: "vitamin_a_mcg", rda: 900, unit: "mcg" },
  { nutrient: "Vitamin C", column: "vitamin_c_mg", rda: 90, unit: "mg" },
  { nutrient: "Vitamin D", column: "vitamin_d_mcg", rda: 15, unit: "mcg" },
  { nutrient: "Vitamin E", column: "vitamin_e_mg", rda: 15, unit: "mg" },
  { nutrient: "Vitamin K", column: "vitamin_k_mcg", rda: 120, unit: "mcg" },
  { nutrient: "Thiamin (B1)", column: "vitamin_b1_mg", rda: 1.2, unit: "mg" },
  { nutrient: "Riboflavin (B2)", column: "vitamin_b2_mg", rda: 1.3, unit: "mg" },
  { nutrient: "Niacin (B3)", column: "vitamin_b3_mg", rda: 16, unit: "mg" },
  { nutrient: "Pantothenic Acid (B5)", column: "vitamin_b5_mg", rda: 5, unit: "mg" },
  { nutrient: "Vitamin B6", column: "vitamin_b6_mg", rda: 1.3, unit: "mg" },
  { nutrient: "Biotin (B7)", column: "vitamin_b7_mcg", rda: 30, unit: "mcg" },
  { nutrient: "Folate (B9)", column: "vitamin_b9_mcg", rda: 400, unit: "mcg" },
  { nutrient: "Vitamin B12", column: "vitamin_b12_mcg", rda: 2.4, unit: "mcg" },
  { nutrient: "Calcium", column: "calcium_mg", rda: 1000, unit: "mg" },
  { nutrient: "Iron", column: "iron_mg", rda: 8, unit: "mg" },
  { nutrient: "Magnesium", column: "magnesium_mg", rda: 420, unit: "mg" },
  { nutrient: "Zinc", column: "zinc_mg", rda: 11, unit: "mg" },
  { nutrient: "Selenium", column: "selenium_mcg", rda: 55, unit: "mcg" },
  { nutrient: "Potassium", column: "potassium_mg", rda: 3400, unit: "mg" },
  { nutrient: "Sodium", column: "sodium_mg", rda: 2300, unit: "mg" },
  { nutrient: "Fiber", column: "fiber_g", rda: 38, unit: "g" },
];

// ── Types ────────────────────────────────────────────────────────────

export interface MicronutrientAdequacyRow {
  nutrient: string;
  unit: string;
  rda: number;
  avgIntake: number;
  percentRda: number;
  daysTracked: number;
}

export interface CaloricBalanceRow {
  date: string;
  caloriesIn: number;
  activeEnergy: number;
  basalEnergy: number;
  totalExpenditure: number;
  balance: number;
  rollingAvgBalance: number | null;
}

export interface AdaptiveTdeeResult {
  estimatedTdee: number | null;
  confidence: number;
  dataPoints: number;
  dailyData: AdaptiveTdeeRow[];
}

export interface AdaptiveTdeeRow {
  date: string;
  caloriesIn: number;
  weightKg: number | null;
  smoothedWeight: number | null;
  estimatedTdee: number | null;
}

export interface MacroRatioRow {
  date: string;
  proteinPct: number;
  carbsPct: number;
  fatPct: number;
  proteinPerKg: number | null;
}

// ── Router ───────────────────────────────────────────────────────────

export const nutritionAnalyticsRouter = router({
  /**
   * Micronutrient adequacy: average daily intake as % of RDA.
   * Aggregates food_entry micronutrient columns over the period,
   * comparing against NIH RDA reference values.
   */
  micronutrientAdequacy: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(30) }))
    .query(async ({ ctx, input }): Promise<MicronutrientAdequacyRow[]> => {
      // Build dynamic SQL to average each micronutrient column per day, then average across days
      const columnAverages = RECOMMENDED_DAILY_ALLOWANCES.map(
        (rda) =>
          `AVG(daily_${rda.column}) AS avg_${rda.column},
           COUNT(daily_${rda.column}) AS days_${rda.column}`,
      ).join(",\n");

      const dailyAggregates = RECOMMENDED_DAILY_ALLOWANCES.map(
        (rda) => `SUM(${rda.column}) AS daily_${rda.column}`,
      ).join(",\n");

      const rows = await ctx.db.execute(
        sql.raw(`
          WITH daily_totals AS (
            SELECT
              date,
              ${dailyAggregates}
            FROM fitness.food_entry
            WHERE user_id = '${ctx.userId}'
              AND confirmed = true
              AND date > CURRENT_DATE - ${input.days}
            GROUP BY date
          )
          SELECT ${columnAverages}
          FROM daily_totals
        `),
      );

      const row = rows[0] as Record<string, number | null> | undefined;
      if (!row) return [];

      return RECOMMENDED_DAILY_ALLOWANCES.map((rda) => {
        const avgIntake = Number(row[`avg_${rda.column}`] ?? 0);
        const daysTracked = Number(row[`days_${rda.column}`] ?? 0);
        return {
          nutrient: rda.nutrient,
          unit: rda.unit,
          rda: rda.rda,
          avgIntake: Math.round(avgIntake * 10) / 10,
          percentRda: rda.rda > 0 ? Math.round((avgIntake / rda.rda) * 1000) / 10 : 0,
          daysTracked,
        };
      }).filter((r) => r.daysTracked > 0);
    }),

  /**
   * Caloric balance: daily calories in vs estimated expenditure.
   * Expenditure = active_energy_kcal + basal_energy_kcal from daily_metrics.
   */
  caloricBalance: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ days: z.number().default(30) }))
    .query(async ({ ctx, input }): Promise<CaloricBalanceRow[]> => {
      const queryDays = input.days + 7; // extra for rolling average warmup

      const rows = await ctx.db.execute(
        sql`WITH nutrition AS (
              SELECT date, SUM(calories) AS calories_in
              FROM fitness.nutrition_daily
              WHERE user_id = ${ctx.userId}
                AND date > CURRENT_DATE - ${queryDays}::int
              GROUP BY date
            ),
            expenditure AS (
              SELECT
                date,
                active_energy_kcal,
                basal_energy_kcal
              FROM fitness.v_daily_metrics
              WHERE user_id = ${ctx.userId}
                AND date > CURRENT_DATE - ${queryDays}::int
            ),
            combined AS (
              SELECT
                COALESCE(n.date, e.date) AS date,
                COALESCE(n.calories_in, 0) AS calories_in,
                COALESCE(e.active_energy_kcal, 0) AS active_energy,
                COALESCE(e.basal_energy_kcal, 0) AS basal_energy
              FROM nutrition n
              FULL OUTER JOIN expenditure e ON n.date = e.date
              WHERE COALESCE(n.date, e.date) IS NOT NULL
            )
            SELECT
              date::text,
              calories_in,
              active_energy,
              basal_energy,
              (active_energy + basal_energy) AS total_expenditure,
              (calories_in - active_energy - basal_energy) AS balance,
              AVG(calories_in - active_energy - basal_energy) OVER (
                ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
              ) AS rolling_avg_balance
            FROM combined
            WHERE date > CURRENT_DATE - ${input.days}::int
            ORDER BY date ASC`,
      );

      return (
        rows as unknown as {
          date: string;
          calories_in: number;
          active_energy: number;
          basal_energy: number;
          total_expenditure: number;
          balance: number;
          rolling_avg_balance: number | null;
        }[]
      ).map((row) => ({
        date: row.date,
        caloriesIn: Math.round(Number(row.calories_in)),
        activeEnergy: Math.round(Number(row.active_energy)),
        basalEnergy: Math.round(Number(row.basal_energy)),
        totalExpenditure: Math.round(Number(row.total_expenditure)),
        balance: Math.round(Number(row.balance)),
        rollingAvgBalance:
          row.rolling_avg_balance != null ? Math.round(Number(row.rolling_avg_balance)) : null,
      }));
    }),

  /**
   * Adaptive TDEE estimation (MacroFactor-style).
   * Uses rolling regression of calorie intake vs. weight change to estimate
   * true daily energy expenditure. More accurate than wearable estimates
   * because it's grounded in actual body mass changes.
   *
   * Method: Over a rolling 28-day window, fit a linear relationship between
   * cumulative caloric surplus/deficit and weight change. The TDEE is the
   * calorie intake level where weight is stable (slope = 0 weight change).
   */
  adaptiveTdee: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }): Promise<AdaptiveTdeeResult> => {
      // Get daily calorie intake and weight measurements
      const rows = await ctx.db.execute(
        sql`WITH nutrition AS (
              SELECT date, SUM(calories) AS calories_in
              FROM fitness.nutrition_daily
              WHERE user_id = ${ctx.userId}
                AND date > CURRENT_DATE - ${input.days}::int
              GROUP BY date
            ),
            weight AS (
              SELECT DISTINCT ON (recorded_at::date)
                recorded_at::date AS date,
                weight_kg
              FROM fitness.v_body_measurement
              WHERE user_id = ${ctx.userId}
                AND weight_kg IS NOT NULL
                AND recorded_at > NOW() - ${input.days}::int * INTERVAL '1 day'
              ORDER BY recorded_at::date, recorded_at DESC
            )
            SELECT
              n.date::text,
              n.calories_in,
              w.weight_kg
            FROM nutrition n
            LEFT JOIN weight w ON w.date = n.date
            ORDER BY n.date ASC`,
      );

      const data = (
        rows as unknown as {
          date: string;
          calories_in: number;
          weight_kg: number | null;
        }[]
      ).map((row) => ({
        date: row.date,
        caloriesIn: Math.round(Number(row.calories_in)),
        weightKg: row.weight_kg != null ? Number(row.weight_kg) : null,
      }));

      // Apply EWMA smoothing to weight (alpha = 0.1) to reduce daily fluctuations
      const smoothedData: AdaptiveTdeeRow[] = [];
      let lastSmoothedWeight: number | null = null;

      for (const day of data) {
        if (day.weightKg != null) {
          if (lastSmoothedWeight == null) {
            lastSmoothedWeight = day.weightKg;
          } else {
            lastSmoothedWeight = 0.1 * day.weightKg + 0.9 * lastSmoothedWeight;
          }
        }
        smoothedData.push({
          date: day.date,
          caloriesIn: day.caloriesIn,
          weightKg: day.weightKg,
          smoothedWeight:
            lastSmoothedWeight != null ? Math.round(lastSmoothedWeight * 100) / 100 : null,
          estimatedTdee: null, // filled below
        });
      }

      // Estimate TDEE using rolling 28-day windows where we have both
      // calorie data and weight change data.
      // TDEE = avg_calories - (weight_change_kg * 7700 / window_days)
      // where 7700 kcal ≈ 1 kg of body mass change
      const KCAL_PER_KG = 7700;
      const WINDOW = 28;
      let latestTdee: number | null = null;
      let dataPointsUsed = 0;

      for (let i = WINDOW; i < smoothedData.length; i++) {
        const windowStart = smoothedData[i - WINDOW];
        const windowEnd = smoothedData[i];

        if (!windowStart || !windowEnd) continue;
        if (windowStart.smoothedWeight == null || windowEnd.smoothedWeight == null) continue;

        const weightChange = windowEnd.smoothedWeight - windowStart.smoothedWeight;
        let totalCalories = 0;
        let calorieDays = 0;

        for (let j = i - WINDOW + 1; j <= i; j++) {
          const day = smoothedData[j];
          if (day && day.caloriesIn > 0) {
            totalCalories += day.caloriesIn;
            calorieDays++;
          }
        }

        if (calorieDays < WINDOW * 0.7) continue; // need at least 70% coverage

        const avgDailyCalories = totalCalories / calorieDays;
        const dailyWeightChangeKcal = (weightChange * KCAL_PER_KG) / WINDOW;
        const tdee = Math.round(avgDailyCalories - dailyWeightChangeKcal);

        if (windowEnd) {
          windowEnd.estimatedTdee = tdee;
        }
        latestTdee = tdee;
        dataPointsUsed++;
      }

      // Confidence based on data coverage
      const totalDays = smoothedData.length;
      const daysWithWeight = smoothedData.filter((d) => d.weightKg != null).length;
      const confidence =
        totalDays >= 28 && daysWithWeight >= 10 ? Math.min(daysWithWeight / totalDays, 1) : 0;

      return {
        estimatedTdee: latestTdee,
        confidence: Math.round(confidence * 100) / 100,
        dataPoints: dataPointsUsed,
        dailyData: smoothedData,
      };
    }),

  /**
   * Macro ratio trends: daily protein/carbs/fat split as percentages,
   * plus protein per kg bodyweight.
   */
  macroRatios: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ days: z.number().default(30) }))
    .query(async ({ ctx, input }): Promise<MacroRatioRow[]> => {
      const rows = await ctx.db.execute(
        sql`WITH daily AS (
              SELECT
                nd.date,
                nd.calories,
                nd.protein_g,
                nd.carbs_g,
                nd.fat_g
              FROM fitness.nutrition_daily nd
              WHERE nd.user_id = ${ctx.userId}
                AND nd.date > CURRENT_DATE - ${input.days}::int
                AND nd.calories > 0
            ),
            latest_weight AS (
              SELECT weight_kg
              FROM fitness.v_body_measurement
              WHERE user_id = ${ctx.userId}
                AND weight_kg IS NOT NULL
              ORDER BY recorded_at DESC
              LIMIT 1
            )
            SELECT
              d.date::text,
              d.protein_g,
              d.carbs_g,
              d.fat_g,
              d.calories,
              lw.weight_kg
            FROM daily d
            CROSS JOIN latest_weight lw
            ORDER BY d.date ASC`,
      );

      return (
        rows as unknown as {
          date: string;
          protein_g: number;
          carbs_g: number;
          fat_g: number;
          calories: number;
          weight_kg: number | null;
        }[]
      ).map((row) => {
        const proteinCal = Number(row.protein_g) * 4;
        const carbsCal = Number(row.carbs_g) * 4;
        const fatCal = Number(row.fat_g) * 9;
        const totalMacroCal = proteinCal + carbsCal + fatCal;
        const divisor = totalMacroCal > 0 ? totalMacroCal : 1;
        const weightKg = row.weight_kg != null ? Number(row.weight_kg) : null;

        return {
          date: row.date,
          proteinPct: Math.round((proteinCal / divisor) * 1000) / 10,
          carbsPct: Math.round((carbsCal / divisor) * 1000) / 10,
          fatPct: Math.round((fatCal / divisor) * 1000) / 10,
          proteinPerKg:
            weightKg != null && weightKg > 0
              ? Math.round((Number(row.protein_g) / weightKg) * 100) / 100
              : null,
        };
      });
    }),
});
