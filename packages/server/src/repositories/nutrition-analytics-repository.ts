import { formatDateYmdInTimeZone } from "@dofek/format/format";
import {
  NUTRIENT_SAFETY_RULESET_REVIEWED_ON,
  type NutrientSafetySource,
} from "@dofek/nutrition/nutrient-safety";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import { BaseRepository } from "../lib/base-repository.ts";
import {
  currentDateRangePredicate,
  dateWindowStartPredicate,
  type RangeDays,
} from "../lib/date-window.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import {
  type BodyClickHouseStore,
  fetchBodyWeightRows,
  fetchLatestBodyMeasurement,
} from "./body-clickhouse.ts";
import {
  fetchMicronutrientSafetyReviews,
  MicronutrientSafetyReview as MicronutrientSafetyReviewModel,
} from "./micronutrient-safety-review.ts";

export const MicronutrientSafetyReview = MicronutrientSafetyReviewModel;
export type MicronutrientSafetyReview = MicronutrientSafetyReviewModel;

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

export interface NutritionAnalyticsDataQuality {
  readonly selectedWindowDays: RangeDays;
  readonly daysWithData: number;
  readonly usableDays: number;
  readonly overlapDays: number;
  readonly conflictDays: number;
  readonly completenessPercent: number | null;
  readonly sourceLabels: string[];
  readonly contributingSourceLabels: string[];
  readonly excludedSourceLabels: string[];
}

export interface SupplementMedicationReview {
  readonly status: "professional_review_recommended" | "no_medication_records" | "no_supplements";
  readonly message: string;
  readonly limitation: string;
  readonly source: NutrientSafetySource;
}

export interface AdaptiveTdeeDataPoint {
  date: string;
  caloriesIn: number | null;
  nutritionStatus: "available" | "source_conflict" | "missing";
  lowerPrioritySourcesExcluded: boolean;
  weightKg: number | null;
}

export interface AdaptiveTdeeDailyRowData {
  date: string;
  caloriesIn: number | null;
  nutritionStatus: "available" | "source_conflict" | "missing";
  lowerPrioritySourcesExcluded: boolean;
  weightKg: number | null;
  smoothedWeight: number | null;
  estimatedTdee: number | null;
}

export interface AdaptiveTdeeEvidence {
  selectedWindowDays: number;
  fitWindowDays: number;
  minimumCalorieDays: number;
  observedDays: number;
  calorieDays: number;
  weightDays: number;
  acceptedWindows: number;
  excludedDays: {
    missingCalories: number;
    sourceConflict: number;
    lowerPrioritySources: number;
  };
}

export interface AdaptiveTdeeResultData {
  status: "available" | "unavailable";
  estimatedTdee: number | null;
  estimateRange: { minimum: number; maximum: number } | null;
  unavailableReason: string | null;
  evidence: AdaptiveTdeeEvidence;
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

  get status(): "available" | "unavailable" {
    return this.#data.status;
  }

  get estimateRange(): { minimum: number; maximum: number } | null {
    return this.#data.estimateRange;
  }

  toDetail() {
    return {
      status: this.#data.status,
      estimatedTdee: this.#data.estimatedTdee,
      estimateRange: this.#data.estimateRange,
      unavailableReason: this.#data.unavailableReason,
      evidence: this.#data.evidence,
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
const MINIMUM_CALORIE_DAYS = Math.ceil(TDEE_WINDOW * 0.7);
/** Bound "All" to the largest explicit chart range to keep the calendar response finite. */
const MAXIMUM_ADAPTIVE_TDEE_DAYS = 365;
const MILLISECONDS_PER_DAY = 86_400_000;

function parseDateYmd(date: string): Date {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new RangeError(`Invalid adaptive TDEE date: ${date}`);
  }
  return parsed;
}

function shiftDateYmd(date: string, days: number): string {
  const shifted = parseDateYmd(date);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function laterDate(first: string, second: string): string {
  return first > second ? first : second;
}

function earlierDate(first: string, second: string): string {
  return first < second ? first : second;
}

/**
 * Build one row per accessible calendar day so missing/conflict nutrition
 * dates count against the rolling fit requirement.
 */
export function buildAdaptiveTdeeCalendar(
  sourceDays: AdaptiveTdeeDataPoint[],
  selectedWindowDays: number,
  today: string,
  accessWindow: AccessWindow,
): AdaptiveTdeeDataPoint[] {
  const sourceByDate = new Map(sourceDays.map((day) => [day.date, day]));
  let startDate = shiftDateYmd(today, -(selectedWindowDays - 1));
  let endDate = today;

  if (accessWindow.kind === "limited") {
    startDate = laterDate(startDate, accessWindow.startDate);
    const accessEnd = shiftDateYmd(accessWindow.endDateExclusive, -1);
    endDate = earlierDate(endDate, accessEnd);
  }

  if (startDate > endDate) return [];

  const numberOfDays =
    Math.floor(
      (parseDateYmd(endDate).getTime() - parseDateYmd(startDate).getTime()) / MILLISECONDS_PER_DAY,
    ) + 1;

  return Array.from({ length: numberOfDays }, (_, index) => {
    const date = shiftDateYmd(startDate, index);
    return (
      sourceByDate.get(date) ?? {
        date,
        caloriesIn: null,
        nutritionStatus: "missing",
        lowerPrioritySourcesExcluded: false,
        weightKg: null,
      }
    );
  });
}

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
      nutritionStatus: day.nutritionStatus,
      lowerPrioritySourcesExcluded: day.lowerPrioritySourcesExcluded,
      weightKg: day.weightKg,
      smoothedWeight:
        lastSmoothedWeight != null ? Math.round(lastSmoothedWeight * 100) / 100 : null,
      estimatedTdee: null,
    });
  }

  return smoothedData;
}

/** Estimate TDEE using rolling 28-day windows on smoothed data. */
function hasUsableCalories(
  day: AdaptiveTdeeDailyRowData,
): day is AdaptiveTdeeDailyRowData & { caloriesIn: number } {
  return day.nutritionStatus === "available" && day.caloriesIn != null && day.caloriesIn > 0;
}

function maximumWindowCalorieDays(smoothedData: AdaptiveTdeeDailyRowData[]): number {
  let maximum = 0;
  for (let index = TDEE_WINDOW; index < smoothedData.length; index++) {
    const calorieDays = smoothedData
      .slice(index - TDEE_WINDOW + 1, index + 1)
      .filter(hasUsableCalories).length;
    maximum = Math.max(maximum, calorieDays);
  }
  return maximum;
}

export function estimateTdee(
  smoothedData: AdaptiveTdeeDailyRowData[],
  selectedWindowDays = 90,
): AdaptiveTdeeResultData {
  let latestTdee: number | null = null;
  const rollingEstimates: number[] = [];

  for (let index = TDEE_WINDOW; index < smoothedData.length; index++) {
    const windowStart = smoothedData[index - TDEE_WINDOW];
    const windowEnd = smoothedData[index];

    if (!windowStart || !windowEnd) continue;
    if (windowStart.smoothedWeight == null || windowEnd.smoothedWeight == null) continue;

    const weightChange = windowEnd.smoothedWeight - windowStart.smoothedWeight;
    const calorieWindow = smoothedData
      .slice(index - TDEE_WINDOW + 1, index + 1)
      .filter(hasUsableCalories);
    const calorieDays = calorieWindow.length;

    if (calorieDays < MINIMUM_CALORIE_DAYS) continue;

    const avgDailyCalories =
      calorieWindow.reduce((total, day) => total + day.caloriesIn, 0) / calorieDays;
    const dailyWeightChangeKcal = (weightChange * KCAL_PER_KG) / TDEE_WINDOW;
    const tdee = Math.round(avgDailyCalories - dailyWeightChangeKcal);

    if (windowEnd) {
      windowEnd.estimatedTdee = tdee;
    }
    latestTdee = tdee;
    rollingEstimates.push(tdee);
  }

  const calorieDays = smoothedData.filter(hasUsableCalories).length;
  const weightDays = smoothedData.filter((day) => day.weightKg != null).length;
  const sourceConflict = smoothedData.filter(
    (day) => day.nutritionStatus === "source_conflict",
  ).length;
  const missingCalories = smoothedData.filter((day) => day.nutritionStatus === "missing").length;
  const lowerPrioritySources = smoothedData.filter(
    (day) => day.nutritionStatus === "available" && day.lowerPrioritySourcesExcluded,
  ).length;
  const evidence: AdaptiveTdeeEvidence = {
    selectedWindowDays,
    fitWindowDays: TDEE_WINDOW,
    minimumCalorieDays: MINIMUM_CALORIE_DAYS,
    observedDays: smoothedData.length,
    calorieDays,
    weightDays,
    acceptedWindows: rollingEstimates.length,
    excludedDays: {
      missingCalories,
      sourceConflict,
      lowerPrioritySources,
    },
  };

  let unavailableReason: string | null = null;
  if (latestTdee == null) {
    if (calorieDays === 0) {
      unavailableReason = "No usable calorie-intake days are available in the selected period.";
    } else if (weightDays === 0) {
      unavailableReason = "No body-weight measurements are available in the selected period.";
    } else if (smoothedData.length <= TDEE_WINDOW) {
      unavailableReason = `At least ${TDEE_WINDOW + 1} calendar days are required for a ${TDEE_WINDOW}-day fit window.`;
    } else {
      const bestWindowCalorieDays = maximumWindowCalorieDays(smoothedData);
      unavailableReason =
        bestWindowCalorieDays < MINIMUM_CALORIE_DAYS
          ? `At least ${MINIMUM_CALORIE_DAYS} usable calorie days are required within one ${TDEE_WINDOW}-day fit window; the best window has ${bestWindowCalorieDays}.`
          : `Body-weight history does not begin early enough to span an eligible ${TDEE_WINDOW}-day fit window.`;
    }
  }

  return {
    status: latestTdee == null ? "unavailable" : "available",
    estimatedTdee: latestTdee,
    estimateRange:
      rollingEstimates.length === 0
        ? null
        : {
            minimum: Math.min(...rollingEstimates),
            maximum: Math.max(...rollingEstimates),
          },
    unavailableReason,
    evidence,
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
    return fetchMicronutrientSafetyReviews({
      db: this.db,
      userId: this.userId,
      days,
      dateAccessPredicate: this.dateAccessPredicate(sql`fen.date`),
    });
  }

  /** Selected-window source coverage and overlap context for nutrient interpretation. */
  async getMicronutrientDataQuality(days: RangeDays): Promise<NutritionAnalyticsDataQuality> {
    const rows = await executeWithSchema(
      this.db,
      z.object({
        date: dateStringSchema,
        resolution_status: z.enum(["available", "source_conflict"]),
        source_labels: z.array(z.string()),
        contributing_source_labels: z.array(z.string()),
        excluded_source_labels: z.array(z.string()),
      }),
      sql`SELECT
            date,
            resolution_status,
            source_labels,
            contributing_source_labels,
            excluded_source_labels
          FROM fitness.v_nutrition_daily
          WHERE user_id = ${this.userId}
            ${currentDateRangePredicate(sql`date`, days)}
            ${this.dateAccessPredicate(sql`date`)}
          ORDER BY date`,
    );

    const sourceLabels = new Set<string>();
    const contributingSourceLabels = new Set<string>();
    const excludedSourceLabels = new Set<string>();
    let usableDays = 0;
    let overlapDays = 0;
    let conflictDays = 0;

    for (const row of rows) {
      for (const label of row.source_labels) sourceLabels.add(label);
      for (const label of row.contributing_source_labels) contributingSourceLabels.add(label);
      for (const label of row.excluded_source_labels) excludedSourceLabels.add(label);

      if (row.resolution_status === "available") {
        usableDays++;
      } else {
        conflictDays++;
      }
      if (row.resolution_status === "source_conflict" || row.excluded_source_labels.length > 0) {
        overlapDays++;
      }
    }

    return {
      selectedWindowDays: days,
      daysWithData: rows.length,
      usableDays,
      overlapDays,
      conflictDays,
      completenessPercent: days == null ? null : Math.round((usableDays / days) * 1_000) / 10,
      sourceLabels: [...sourceLabels].sort(),
      contributingSourceLabels: [...contributingSourceLabels].sort(),
      excludedSourceLabels: [...excludedSourceLabels].sort(),
    };
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
                FROM fitness.clinical_record
                WHERE user_id = ${this.userId}
                  AND clinical_type = 'medication'
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
  async getAdaptiveTdeeData(days: number, endDate: string): Promise<AdaptiveTdeeDataPoint[]> {
    const [nutritionRows, weightRows] = await Promise.all([
      this.query(
        z.object({
          date: dateStringSchema,
          calories_in: z.coerce.number().nullable(),
          resolution_status: z.enum(["available", "source_conflict"]),
          excluded_source_labels: z.array(z.string()),
        }),
        sql`SELECT date, calories AS calories_in, resolution_status, excluded_source_labels
            FROM fitness.v_nutrition_daily
            WHERE user_id = ${this.userId}
              ${dateWindowStartPredicate(sql`date`, endDate, days)}
              AND date <= ${endDate}::date
              ${this.dateAccessPredicate(sql`date`)}
            ORDER BY date ASC`,
      ),
      fetchBodyWeightRows(this.#requireBodyStore(), this.userId, this.timezone, endDate, days, {
        accessWindow: this.accessWindow,
      }),
    ]);

    const rowsByDate = new Map<string, AdaptiveTdeeDataPoint>(
      nutritionRows.map((row) => [
        row.date,
        {
          date: row.date,
          caloriesIn:
            row.resolution_status === "available" && row.calories_in != null
              ? Math.round(Number(row.calories_in))
              : null,
          nutritionStatus: row.resolution_status,
          lowerPrioritySourcesExcluded: row.excluded_source_labels.length > 0,
          weightKg: null,
        },
      ]),
    );
    for (const weightRow of weightRows) {
      const existing = rowsByDate.get(weightRow.date);
      rowsByDate.set(weightRow.date, {
        date: weightRow.date,
        caloriesIn: existing?.caloriesIn ?? null,
        nutritionStatus: existing?.nutritionStatus ?? "missing",
        lowerPrioritySourcesExcluded: existing?.lowerPrioritySourcesExcluded ?? false,
        weightKg: Number(weightRow.weight_kg),
      });
    }
    return [...rowsByDate.values()].sort((left, right) => left.date.localeCompare(right.date));
  }

  /** Adaptive TDEE estimation using weight smoothing and rolling regression. */
  async getAdaptiveTdee(days: RangeDays): Promise<AdaptiveTdeeEstimate> {
    const selectedWindowDays = days ?? MAXIMUM_ADAPTIVE_TDEE_DAYS;
    const endDate = formatDateYmdInTimeZone(new Date(), this.timezone);
    const sourceData = await this.getAdaptiveTdeeData(selectedWindowDays, endDate);
    const calendar = buildAdaptiveTdeeCalendar(
      sourceData,
      selectedWindowDays,
      endDate,
      this.accessWindow,
    );
    const smoothedData = smoothWeightData(calendar);
    const result = estimateTdee(smoothedData, selectedWindowDays);
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
