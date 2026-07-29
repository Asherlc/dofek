import {
  type DailyValueReference,
  evaluateNutrientUpperLimit,
  getNutrientDailyValue,
  NUTRIENT_SAFETY_RULESET_REVIEWED_ON,
  type NutrientSafetySource,
  type UpperLimitEvaluation,
} from "@dofek/nutrition/nutrient-safety";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import { BaseRepository } from "../lib/base-repository.ts";
import { currentDateRangePredicate, type RangeDays } from "../lib/date-window.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import {
  type BodyClickHouseStore,
  fetchBodyWeightRows,
  fetchLatestBodyMeasurement,
} from "./body-clickhouse.ts";

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

export type MicronutrientSafetyStatus =
  | "at_or_above_upper_limit"
  | "upper_limit_not_evaluable"
  | "within_upper_limit"
  | "no_upper_limit_in_ruleset";

export type DailyValueEvaluation =
  | {
      readonly status: "below_daily_value" | "at_or_above_daily_value";
      readonly percentDailyValue: number;
      readonly reference: DailyValueReference;
      readonly message: string;
    }
  | {
      readonly status: "not_evaluable";
      readonly reference: DailyValueReference;
      readonly limitation: string;
      readonly message: string;
    };

export interface MicronutrientSafetyReviewData {
  readonly nutrientId: string;
  readonly nutrient: string;
  readonly unit: string;
  readonly totalDailyAverage: number;
  readonly foodDailyAverage: number;
  readonly supplementDailyAverage: number;
  readonly daysTracked: number;
}

function upperLimitMessage(evaluation: UpperLimitEvaluation): string {
  switch (evaluation.status) {
    case "at_or_above_limit":
      return "Average intake over recorded days is at or above the included NIH adult upper limit. Review this intake with a doctor or pharmacist.";
    case "within_limit":
      return "Average intake over recorded days is below the included NIH adult upper limit. This does not rule out medication interactions or individual risks.";
    case "not_evaluable":
      return evaluation.limitation;
    case "not_in_ruleset":
      return evaluation.limitation;
  }
}

function safetyStatus(evaluation: UpperLimitEvaluation): MicronutrientSafetyStatus {
  switch (evaluation.status) {
    case "at_or_above_limit":
      return "at_or_above_upper_limit";
    case "within_limit":
      return "within_upper_limit";
    case "not_evaluable":
      return "upper_limit_not_evaluable";
    case "not_in_ruleset":
      return "no_upper_limit_in_ruleset";
  }
}

/** Server-owned safety context for a single tracked nutrient. */
export class MicronutrientSafetyReview {
  readonly #row: MicronutrientSafetyReviewData;
  readonly #adequacy: DailyValueEvaluation | null;
  readonly #upperLimit: UpperLimitEvaluation & { readonly message: string };
  readonly #safetyStatus: MicronutrientSafetyStatus;

  constructor(row: MicronutrientSafetyReviewData) {
    this.#row = row;
    const dailyValue = getNutrientDailyValue(row.nutrientId);
    if (dailyValue == null) {
      this.#adequacy = null;
    } else if (dailyValue.unit !== row.unit) {
      const limitation = `Tracked unit ${row.unit} does not match the FDA Daily Value unit ${dailyValue.unit}.`;
      this.#adequacy = {
        status: "not_evaluable",
        reference: dailyValue,
        limitation,
        message: limitation,
      };
    } else {
      const percentDailyValue =
        dailyValue.amount > 0
          ? Math.round((row.totalDailyAverage / dailyValue.amount) * 1_000) / 10
          : 0;
      this.#adequacy = {
        status:
          row.totalDailyAverage >= dailyValue.amount
            ? "at_or_above_daily_value"
            : "below_daily_value",
        percentDailyValue,
        reference: dailyValue,
        message:
          row.totalDailyAverage >= dailyValue.amount
            ? "Average intake over recorded days meets or exceeds the FDA Daily Value. This generic label reference is not a personalized safety assessment."
            : "Average intake over recorded days is below the FDA Daily Value. This generic label reference is not a personalized deficiency assessment.",
      };
    }

    const upperLimit = evaluateNutrientUpperLimit({
      nutrientId: row.nutrientId,
      unit: row.unit,
      totalDailyAmount: row.totalDailyAverage,
      supplementalDailyAmount: row.supplementDailyAverage,
    });
    this.#upperLimit = { ...upperLimit, message: upperLimitMessage(upperLimit) };
    this.#safetyStatus = safetyStatus(upperLimit);
  }

  toDetail() {
    return {
      nutrientId: this.#row.nutrientId,
      nutrient: this.#row.nutrient,
      unit: this.#row.unit,
      intake: {
        totalDailyAverage: Math.round(this.#row.totalDailyAverage * 10) / 10,
        foodDailyAverage: Math.round(this.#row.foodDailyAverage * 10) / 10,
        supplementDailyAverage: Math.round(this.#row.supplementDailyAverage * 10) / 10,
        daysTracked: this.#row.daysTracked,
      },
      adequacy: this.#adequacy,
      upperLimit: this.#upperLimit,
      safetyStatus: this.#safetyStatus,
    };
  }
}

export interface SupplementMedicationReview {
  readonly status: "professional_review_recommended" | "no_medication_records" | "no_supplements";
  readonly message: string;
  readonly limitation: string;
  readonly source: NutrientSafetySource;
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
  readonly #bodyStore: BodyClickHouseStore | undefined;

  constructor(
    db: Pick<Database, "execute">,
    userId: string,
    timezone = "UTC",
    accessWindow?: AccessWindow,
    bodyStore?: BodyClickHouseStore,
  ) {
    super(db, userId, timezone, accessWindow);
    this.#bodyStore = bodyStore;
  }

  /** Micronutrient adequacy: average daily intake as % of RDA. */
  async getMicronutrientAdequacy(days: RangeDays): Promise<MicronutrientAdequacy[]> {
    const rows = await executeWithSchema(
      this.db,
      z.object({
        nutrient: z.string(),
        unit: z.string(),
        rda: z.coerce.number(),
        avg_intake: z.coerce.number(),
        days_tracked: z.coerce.number(),
      }),
      sql`WITH daily_totals AS (
            SELECT
              fen.date,
              n.id,
              n.display_name,
              n.unit,
              n.rda,
              SUM(fen.amount) AS daily_amount
            FROM fitness.v_nutrition_canonical_nutrient fen
            JOIN fitness.nutrient n ON n.id = fen.nutrient_id
            WHERE fen.user_id = ${this.userId}
              ${currentDateRangePredicate(sql`fen.date`, days)}
              AND n.rda IS NOT NULL
              ${this.dateAccessPredicate(sql`fen.date`)}
            GROUP BY fen.date, n.id, n.display_name, n.unit, n.rda
          )
          SELECT
            display_name AS nutrient,
            unit,
            rda,
            AVG(daily_amount) AS avg_intake,
            COUNT(daily_amount) AS days_tracked
          FROM daily_totals
          GROUP BY id, display_name, unit, rda
          ORDER BY display_name`,
    );

    return rows.map((row) => {
      const avgIntake = Number(row.avg_intake);
      const daysTracked = Number(row.days_tracked);
      return new MicronutrientAdequacy({
        nutrient: row.nutrient,
        unit: row.unit,
        rda: row.rda,
        avgIntake: Math.round(avgIntake * 10) / 10,
        percentRda: row.rda > 0 ? Math.round((avgIntake / row.rda) * 1000) / 10 : 0,
        daysTracked,
      });
    });
  }

  /** Source-aware intake review against FDA Daily Values and the bounded NIH UL ruleset. */
  async getMicronutrientSafetyReview(days: RangeDays): Promise<MicronutrientSafetyReview[]> {
    const rows = await executeWithSchema(
      this.db,
      z.object({
        nutrient_id: z.string(),
        nutrient: z.string(),
        unit: z.string(),
        avg_total_intake: z.coerce.number(),
        avg_food_intake: z.coerce.number(),
        avg_supplement_intake: z.coerce.number(),
        days_tracked: z.coerce.number(),
      }),
      sql`WITH daily_totals AS (
            SELECT
              fen.date,
              n.id,
              n.display_name,
              n.unit,
              SUM(fen.amount) AS total_amount,
              COALESCE(
                SUM(fen.amount) FILTER (WHERE fen.food_entry_id IS NOT NULL),
                0
              ) AS food_amount,
              COALESCE(
                SUM(fen.amount) FILTER (WHERE fen.supplement_dose_event_id IS NOT NULL),
                0
              ) AS supplement_amount
            FROM fitness.v_nutrition_canonical_nutrient fen
            JOIN fitness.nutrient n ON n.id = fen.nutrient_id
            WHERE fen.user_id = ${this.userId}
              ${currentDateRangePredicate(sql`fen.date`, days)}
              ${this.dateAccessPredicate(sql`fen.date`)}
            GROUP BY fen.date, n.id, n.display_name, n.unit
          )
          SELECT
            id AS nutrient_id,
            display_name AS nutrient,
            unit,
            AVG(total_amount) AS avg_total_intake,
            AVG(food_amount) AS avg_food_intake,
            AVG(supplement_amount) AS avg_supplement_intake,
            COUNT(total_amount) AS days_tracked
          FROM daily_totals
          GROUP BY id, display_name, unit
          ORDER BY display_name`,
    );

    return rows.flatMap((row) => {
      const upperLimit = evaluateNutrientUpperLimit({
        nutrientId: row.nutrient_id,
        unit: row.unit,
        totalDailyAmount: row.avg_total_intake,
        supplementalDailyAmount: row.avg_supplement_intake,
      });
      if (
        getNutrientDailyValue(row.nutrient_id) == null &&
        upperLimit.status === "not_in_ruleset"
      ) {
        return [];
      }

      return [
        new MicronutrientSafetyReview({
          nutrientId: row.nutrient_id,
          nutrient: row.nutrient,
          unit: row.unit,
          totalDailyAverage: row.avg_total_intake,
          foodDailyAverage: row.avg_food_intake,
          supplementDailyAverage: row.avg_supplement_intake,
          daysTracked: row.days_tracked,
        }),
      ];
    });
  }

  /** General review state; no medication-specific interaction is inferred. */
  async getSupplementMedicationReview(): Promise<SupplementMedicationReview> {
    const rows = await executeWithSchema(
      this.db,
      z.object({
        has_medication_records: z.boolean(),
        has_supplements: z.boolean(),
      }),
      sql`SELECT
            (
              EXISTS (
                SELECT 1
                FROM fitness.medication
                WHERE user_id = ${this.userId}
              )
              OR EXISTS (
                SELECT 1
                FROM fitness.medication_dose_event
                WHERE user_id = ${this.userId}
              )
            ) AS has_medication_records,
            EXISTS (
              SELECT 1
              FROM fitness.supplement s
              JOIN fitness.supplement_definition definition
                ON definition.supplement_id = s.id
                AND definition.effective_to IS NULL
              WHERE s.user_id = ${this.userId}
            ) AS has_supplements`,
    );
    const row = rows[0];
    if (!row) {
      throw new Error("Supplement and medication review query returned no status row.");
    }

    const source: NutrientSafetySource = {
      agency: "FDA",
      title: "Mixing Medications and Dietary Supplements Can Endanger Your Health",
      url: "https://www.fda.gov/consumers/consumer-updates/mixing-medications-and-dietary-supplements-can-endanger-your-health",
      reviewedOn: NUTRIENT_SAFETY_RULESET_REVIEWED_ON,
    };
    const limitation =
      "Dofek does not determine whether a specific medication and supplement interact.";

    if (!row.has_supplements) {
      return {
        status: "no_supplements",
        message: "Add supplements to review them alongside your medication records.",
        limitation,
        source,
      };
    }
    if (!row.has_medication_records) {
      return {
        status: "no_medication_records",
        message:
          "No medication records are available for a combined review. Keep your doctor or pharmacist informed about all supplements you take.",
        limitation,
        source,
      };
    }
    return {
      status: "professional_review_recommended",
      message:
        "Review your complete medication and supplement list with a doctor or pharmacist because supplements can interact with medications.",
      limitation,
      source,
    };
  }

  /** Raw daily calorie + weight data for adaptive TDEE estimation. */
  async getAdaptiveTdeeData(days: RangeDays): Promise<AdaptiveTdeeDataPoint[]> {
    const [nutritionRows, weightRows] = await Promise.all([
      this.query(
        z.object({
          date: dateStringSchema,
          calories_in: z.coerce.number(),
        }),
        sql`SELECT date, calories AS calories_in
            FROM fitness.v_nutrition_daily
            WHERE user_id = ${this.userId}
              AND resolution_status = 'available'
              AND calories IS NOT NULL
              ${currentDateRangePredicate(sql`date`, days)}
              ${this.dateAccessPredicate(sql`date`)}
            ORDER BY date ASC`,
      ),
      fetchBodyWeightRows(this.#requireBodyStore(), this.userId, this.timezone, "now", days, {
        accessWindow: this.accessWindow,
      }),
    ]);

    const weightByDate = new Map(weightRows.map((row) => [row.date, row.weight_kg]));
    const rows = nutritionRows.map((row) => ({
      ...row,
      weight_kg: weightByDate.get(row.date) ?? null,
    }));

    return rows.map((row) => ({
      date: row.date,
      caloriesIn: Math.round(Number(row.calories_in)),
      weightKg: row.weight_kg != null ? Number(row.weight_kg) : null,
    }));
  }

  /** Adaptive TDEE estimation using weight smoothing and rolling regression. */
  async getAdaptiveTdee(days: RangeDays): Promise<AdaptiveTdeeEstimate> {
    const data = await this.getAdaptiveTdeeData(days);
    const smoothedData = smoothWeightData(data);
    const result = estimateTdee(smoothedData);
    return new AdaptiveTdeeEstimate(result);
  }

  /** Macro ratio trends: daily protein/carbs/fat split as percentages. */
  async getMacroRatios(days: RangeDays): Promise<MacroRatioDay[]> {
    const [rows, latestBodyMeasurement] = await Promise.all([
      this.query(
        macroRatioRowSchema.omit({ weight_kg: true }),
        sql`WITH daily AS (
              SELECT
                nd.date,
                nd.calories,
                nd.protein_g,
                nd.carbs_g,
                nd.fat_g
              FROM fitness.v_nutrition_daily nd
              WHERE nd.user_id = ${this.userId}
                AND nd.resolution_status = 'available'
                ${currentDateRangePredicate(sql`nd.date`, days)}
                AND nd.calories > 0
                ${this.dateAccessPredicate(sql`nd.date`)}
            )
            SELECT
              d.date::text,
              d.protein_g,
              d.carbs_g,
              d.fat_g,
              d.calories
            FROM daily d
            ORDER BY d.date ASC`,
      ),
      fetchLatestBodyMeasurement(this.#requireBodyStore(), this.userId),
    ]);
    const weightKg =
      latestBodyMeasurement?.weight_kg != null ? Number(latestBodyMeasurement.weight_kg) : null;

    return rows.map((row) => {
      const proteinCal = Number(row.protein_g) * 4;
      const carbsCal = Number(row.carbs_g) * 4;
      const fatCal = Number(row.fat_g) * 9;
      const totalMacroCal = proteinCal + carbsCal + fatCal;
      const divisor = totalMacroCal > 0 ? totalMacroCal : 1;

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

  #requireBodyStore(): BodyClickHouseStore {
    if (!this.#bodyStore) {
      throw new Error(
        "nutrition analytics body metrics require the ClickHouse body measurement store",
      );
    }
    return this.#bodyStore;
  }
}
