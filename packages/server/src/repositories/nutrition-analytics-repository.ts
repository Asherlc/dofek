import { sql } from "drizzle-orm";
import { z } from "zod";
import { BaseRepository } from "../lib/base-repository.ts";
import { bodyWeightDedupCte } from "../lib/sql-fragments.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";

// ---------------------------------------------------------------------------
// RDA Reference Data
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Domain models
// ---------------------------------------------------------------------------

export interface MicronutrientAdequacyRowData {
  nutrient: string;
  unit: string;
  rda: number;
  avgIntake: number;
  percentRda: number;
  daysTracked: number;
}

/** A single micronutrient's average intake compared against its RDA. */
export class MicronutrientAdequacy {
  readonly #row: MicronutrientAdequacyRowData;

  constructor(row: MicronutrientAdequacyRowData) {
    this.#row = row;
  }

  get nutrient(): string {
    return this.#row.nutrient;
  }

  get unit(): string {
    return this.#row.unit;
  }

  get rda(): number {
    return this.#row.rda;
  }

  get avgIntake(): number {
    return this.#row.avgIntake;
  }

  get percentRda(): number {
    return this.#row.percentRda;
  }

  get daysTracked(): number {
    return this.#row.daysTracked;
  }

  toDetail() {
    return {
      nutrient: this.#row.nutrient,
      unit: this.#row.unit,
      rda: this.#row.rda,
      avgIntake: this.#row.avgIntake,
      percentRda: this.#row.percentRda,
      daysTracked: this.#row.daysTracked,
    };
  }
}

export interface CaloricBalanceRowData {
  date: string;
  caloriesIn: number;
  activeEnergy: number;
  basalEnergy: number;
  totalExpenditure: number;
  balance: number;
  rollingAvgBalance: number | null;
}

/** A single day's caloric balance (intake vs expenditure). */
export class CaloricBalanceDay {
  readonly #row: CaloricBalanceRowData;

  constructor(row: CaloricBalanceRowData) {
    this.#row = row;
  }

  get date(): string {
    return this.#row.date;
  }

  get balance(): number {
    return this.#row.balance;
  }

  toDetail() {
    return {
      date: this.#row.date,
      caloriesIn: this.#row.caloriesIn,
      activeEnergy: this.#row.activeEnergy,
      basalEnergy: this.#row.basalEnergy,
      totalExpenditure: this.#row.totalExpenditure,
      balance: this.#row.balance,
      rollingAvgBalance: this.#row.rollingAvgBalance,
    };
  }
}

export interface AdaptiveTdeeDataPoint {
  date: string;
  caloriesIn: number;
  weightKg: number | null;
}

export interface AdaptiveTdeeDailyRowData {
  date: string;
  caloriesIn: number;
  weightKg: number | null;
  smoothedWeight: number | null;
  estimatedTdee: number | null;
}

export interface AdaptiveTdeeResultData {
  estimatedTdee: number | null;
  confidence: number;
  dataPoints: number;
  dailyData: AdaptiveTdeeDailyRowData[];
}

/** Result of adaptive TDEE estimation with smoothed weight and rolling estimates. */
export class AdaptiveTdeeEstimate {
  readonly #data: AdaptiveTdeeResultData;

  constructor(data: AdaptiveTdeeResultData) {
    this.#data = data;
  }

  get estimatedTdee(): number | null {
    return this.#data.estimatedTdee;
  }

  get confidence(): number {
    return this.#data.confidence;
  }

  get dataPoints(): number {
    return this.#data.dataPoints;
  }

  toDetail() {
    return {
      estimatedTdee: this.#data.estimatedTdee,
      confidence: this.#data.confidence,
      dataPoints: this.#data.dataPoints,
      dailyData: this.#data.dailyData,
    };
  }
}

export interface MacroRatioRowData {
  date: string;
  proteinPct: number;
  carbsPct: number;
  fatPct: number;
  proteinPerKg: number | null;
}

/** A single day's macronutrient ratio breakdown. */
export class MacroRatioDay {
  readonly #row: MacroRatioRowData;

  constructor(row: MacroRatioRowData) {
    this.#row = row;
  }

  get date(): string {
    return this.#row.date;
  }

  get proteinPct(): number {
    return this.#row.proteinPct;
  }

  toDetail() {
    return {
      date: this.#row.date,
      proteinPct: this.#row.proteinPct,
      carbsPct: this.#row.carbsPct,
      fatPct: this.#row.fatPct,
      proteinPerKg: this.#row.proteinPerKg,
    };
  }
}

// ---------------------------------------------------------------------------
// Zod schemas for raw DB rows
// ---------------------------------------------------------------------------

const caloricBalanceRowSchema = z.object({
  date: dateStringSchema,
  calories_in: z.coerce.number(),
  active_energy: z.coerce.number(),
  basal_energy: z.coerce.number(),
  total_expenditure: z.coerce.number(),
  balance: z.coerce.number(),
  rolling_avg_balance: z.coerce.number().nullable(),
});

const adaptiveTdeeRowSchema = z.object({
  date: dateStringSchema,
  calories_in: z.coerce.number(),
  weight_kg: z.coerce.number().nullable(),
});

const macroRatioRowSchema = z.object({
  date: dateStringSchema,
  protein_g: z.coerce.number(),
  carbs_g: z.coerce.number(),
  fat_g: z.coerce.number(),
  calories: z.coerce.number(),
  weight_kg: z.coerce.number().nullable(),
});

// ---------------------------------------------------------------------------
// TDEE computation helpers (exported for testing)
// ---------------------------------------------------------------------------

const KCAL_PER_KG = 7700;
const TDEE_WINDOW = 28;

/** Apply EWMA smoothing to weight data and prepare daily data array. */
export function smoothWeightData(data: AdaptiveTdeeDataPoint[]): AdaptiveTdeeDailyRowData[] {
  const smoothedData: AdaptiveTdeeDailyRowData[] = [];
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
      estimatedTdee: null,
    });
  }

  return smoothedData;
}

/** Estimate TDEE using rolling 28-day windows on smoothed data. */
export function estimateTdee(smoothedData: AdaptiveTdeeDailyRowData[]): AdaptiveTdeeResultData {
  let latestTdee: number | null = null;
  let dataPointsUsed = 0;

  for (let index = TDEE_WINDOW; index < smoothedData.length; index++) {
    const windowStart = smoothedData[index - TDEE_WINDOW];
    const windowEnd = smoothedData[index];

    if (!windowStart || !windowEnd) continue;
    if (windowStart.smoothedWeight == null || windowEnd.smoothedWeight == null) continue;

    const weightChange = windowEnd.smoothedWeight - windowStart.smoothedWeight;
    let totalCalories = 0;
    let calorieDays = 0;

    for (let windowIndex = index - TDEE_WINDOW + 1; windowIndex <= index; windowIndex++) {
      const day = smoothedData[windowIndex];
      if (day && day.caloriesIn > 0) {
        totalCalories += day.caloriesIn;
        calorieDays++;
      }
    }

    if (calorieDays < TDEE_WINDOW * 0.7) continue;

    const avgDailyCalories = totalCalories / calorieDays;
    const dailyWeightChangeKcal = (weightChange * KCAL_PER_KG) / TDEE_WINDOW;
    const tdee = Math.round(avgDailyCalories - dailyWeightChangeKcal);

    if (windowEnd) {
      windowEnd.estimatedTdee = tdee;
    }
    latestTdee = tdee;
    dataPointsUsed++;
  }

  const totalDays = smoothedData.length;
  const daysWithWeight = smoothedData.filter((day) => day.weightKg != null).length;
  const confidence =
    totalDays >= 28 && daysWithWeight >= 10 ? Math.min(daysWithWeight / totalDays, 1) : 0;

  return {
    estimatedTdee: latestTdee,
    confidence: Math.round(confidence * 100) / 100,
    dataPoints: dataPointsUsed,
    dailyData: smoothedData,
  };
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for nutrition analytics (micronutrients, caloric balance, TDEE, macros). */
export class NutritionAnalyticsRepository extends BaseRepository {
  /** Micronutrient adequacy: average daily intake as % of RDA. */
  async getMicronutrientAdequacy(days: number): Promise<MicronutrientAdequacy[]> {
    const VALID_COLUMNS = new Set(RECOMMENDED_DAILY_ALLOWANCES.map((rda) => rda.column));
    for (const rda of RECOMMENDED_DAILY_ALLOWANCES) {
      if (!VALID_COLUMNS.has(rda.column) || !/^[a-z0-9_]+$/.test(rda.column)) {
        throw new Error(`Invalid column name in RDA config: ${rda.column}`);
      }
    }

    const columnAverages = RECOMMENDED_DAILY_ALLOWANCES.map(
      (rda) =>
        `AVG(daily_${rda.column}) AS avg_${rda.column},
         COUNT(daily_${rda.column}) AS days_${rda.column}`,
    ).join(",\n");

    const dailyAggregates = RECOMMENDED_DAILY_ALLOWANCES.map(
      (rda) => `SUM(nd.${rda.column}) AS daily_${rda.column}`,
    ).join(",\n");

    const rows = await executeWithSchema(
      this.db,
      z.record(z.string(), z.coerce.number().nullable()),
      sql`WITH daily_totals AS (
            SELECT
              fe.date,
              ${sql.raw(dailyAggregates)}
            FROM fitness.food_entry fe
            JOIN fitness.food_entry_nutrition nd ON nd.food_entry_id = fe.id
            WHERE fe.user_id = ${this.userId}
              AND fe.confirmed = true
              AND fe.date > CURRENT_DATE - ${days}::int
            GROUP BY fe.date
          )
          SELECT ${sql.raw(columnAverages)}
          FROM daily_totals`,
    );

    const row = rows[0];
    if (!row) return [];

    return RECOMMENDED_DAILY_ALLOWANCES.map((rda) => {
      const avgIntake = Number(row[`avg_${rda.column}`] ?? 0);
      const daysTracked = Number(row[`days_${rda.column}`] ?? 0);
      return new MicronutrientAdequacy({
        nutrient: rda.nutrient,
        unit: rda.unit,
        rda: rda.rda,
        avgIntake: Math.round(avgIntake * 10) / 10,
        percentRda: rda.rda > 0 ? Math.round((avgIntake / rda.rda) * 1000) / 10 : 0,
        daysTracked,
      });
    }).filter((model) => model.daysTracked > 0);
  }

  /** Caloric balance: daily calories in vs estimated expenditure. */
  async getCaloricBalance(days: number): Promise<CaloricBalanceDay[]> {
    const queryDays = days + 7; // extra for rolling average warmup

    const rows = await this.query(
      caloricBalanceRowSchema,
      sql`WITH nutrition AS (
            SELECT date, SUM(calories) AS calories_in
            FROM fitness.nutrition_daily
            WHERE user_id = ${this.userId}
              AND date > CURRENT_DATE - ${queryDays}::int
            GROUP BY date
          ),
          expenditure AS (
            SELECT
              date,
              active_energy_kcal,
              basal_energy_kcal
            FROM fitness.v_daily_metrics
            WHERE user_id = ${this.userId}
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
          WHERE date > CURRENT_DATE - ${days}::int
          ORDER BY date ASC`,
    );

    return rows.map(
      (row) =>
        new CaloricBalanceDay({
          date: row.date,
          caloriesIn: Math.round(Number(row.calories_in)),
          activeEnergy: Math.round(Number(row.active_energy)),
          basalEnergy: Math.round(Number(row.basal_energy)),
          totalExpenditure: Math.round(Number(row.total_expenditure)),
          balance: Math.round(Number(row.balance)),
          rollingAvgBalance:
            row.rolling_avg_balance != null ? Math.round(Number(row.rolling_avg_balance)) : null,
        }),
    );
  }

  /** Raw daily calorie + weight data for adaptive TDEE estimation. */
  async getAdaptiveTdeeData(days: number): Promise<AdaptiveTdeeDataPoint[]> {
    const rows = await this.query(
      adaptiveTdeeRowSchema,
      sql`WITH nutrition AS (
            SELECT date, SUM(calories) AS calories_in
            FROM fitness.nutrition_daily
            WHERE user_id = ${this.userId}
              AND date > CURRENT_DATE - ${days}::int
            GROUP BY date
          ),
          ${bodyWeightDedupCte(this.userId, this.timezone, "now", days)}
          SELECT
            n.date::text,
            n.calories_in,
            w.weight_kg
          FROM nutrition n
          LEFT JOIN weight_deduped w ON w.date = n.date::text
          ORDER BY n.date ASC`,
    );

    return rows.map((row) => ({
      date: row.date,
      caloriesIn: Math.round(Number(row.calories_in)),
      weightKg: row.weight_kg != null ? Number(row.weight_kg) : null,
    }));
  }

  /** Adaptive TDEE estimation using weight smoothing and rolling regression. */
  async getAdaptiveTdee(days: number): Promise<AdaptiveTdeeEstimate> {
    const data = await this.getAdaptiveTdeeData(days);
    const smoothedData = smoothWeightData(data);
    const result = estimateTdee(smoothedData);
    return new AdaptiveTdeeEstimate(result);
  }

  /** Macro ratio trends: daily protein/carbs/fat split as percentages. */
  async getMacroRatios(days: number): Promise<MacroRatioDay[]> {
    const rows = await this.query(
      macroRatioRowSchema,
      sql`WITH daily AS (
            SELECT
              nd.date,
              nd.calories,
              nd.protein_g,
              nd.carbs_g,
              nd.fat_g
            FROM fitness.nutrition_daily nd
            WHERE nd.user_id = ${this.userId}
              AND nd.date > CURRENT_DATE - ${days}::int
              AND nd.calories > 0
          ),
          latest_weight AS (
            SELECT weight_kg
            FROM fitness.v_body_measurement
            WHERE user_id = ${this.userId}
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

    return rows.map((row) => {
      const proteinCal = Number(row.protein_g) * 4;
      const carbsCal = Number(row.carbs_g) * 4;
      const fatCal = Number(row.fat_g) * 9;
      const totalMacroCal = proteinCal + carbsCal + fatCal;
      const divisor = totalMacroCal > 0 ? totalMacroCal : 1;
      const weightKg = row.weight_kg != null ? Number(row.weight_kg) : null;

      return new MacroRatioDay({
        date: row.date,
        proteinPct: Math.round((proteinCal / divisor) * 1000) / 10,
        carbsPct: Math.round((carbsCal / divisor) * 1000) / 10,
        fatPct: Math.round((fatCal / divisor) * 1000) / 10,
        proteinPerKg:
          weightKg != null && weightKg > 0
            ? Math.round((Number(row.protein_g) / weightKg) * 100) / 100
            : null,
      });
    });
  }
}
