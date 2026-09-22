import {
  type DailyValueReference,
  evaluateNutrientUpperLimit,
  getNutrientDailyValue,
  type UpperLimitEvaluation,
} from "@dofek/nutrition/nutrient-safety";
import type { Database } from "dofek/db";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { currentDateRangePredicate, type RangeDays } from "../lib/date-window.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";

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
  readonly providerDailyTotalAverage: number;
  readonly supplementDailyAverage: number;
  readonly daysTracked: number;
  readonly sourceBreakdown: NutritionSourceContribution[];
}

export type NutritionIntakeType =
  | "itemized_food"
  | "meal_aggregate"
  | "provider_daily_total"
  | "supplement";

export interface NutritionSourceContribution {
  readonly providerId: string;
  readonly sourceLabel: string;
  readonly intakeType: NutritionIntakeType;
  readonly dailyAverageContribution: number;
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
        providerDailyTotalAverage: Math.round(this.#row.providerDailyTotalAverage * 10) / 10,
        supplementDailyAverage: Math.round(this.#row.supplementDailyAverage * 10) / 10,
        daysTracked: this.#row.daysTracked,
      },
      sourceBreakdown: this.#row.sourceBreakdown.map((source) => ({
        ...source,
        dailyAverageContribution: Math.round(source.dailyAverageContribution * 10) / 10,
      })),
      adequacy: this.#adequacy,
      upperLimit: this.#upperLimit,
      safetyStatus: this.#safetyStatus,
    };
  }
}

const micronutrientSafetyReviewRowSchema = z.object({
  nutrient_id: z.string(),
  nutrient: z.string(),
  unit: z.string(),
  avg_total_intake: z.coerce.number(),
  avg_food_intake: z.coerce.number(),
  avg_provider_daily_total_intake: z.coerce.number(),
  avg_supplement_intake: z.coerce.number(),
  days_tracked: z.coerce.number(),
  source_breakdown: z.array(
    z.object({
      providerId: z.string(),
      sourceLabel: z.string(),
      intakeType: z.enum(["itemized_food", "meal_aggregate", "provider_daily_total", "supplement"]),
      dailyAverageContribution: z.coerce.number(),
      daysTracked: z.coerce.number(),
    }),
  ),
});

export async function fetchMicronutrientSafetyReviews(options: {
  db: Pick<Database, "execute">;
  userId: string;
  days: RangeDays;
  dateAccessPredicate: SQL;
}): Promise<MicronutrientSafetyReview[]> {
  const rows = await executeWithSchema(
    options.db,
    micronutrientSafetyReviewRowSchema,
    sql`WITH contributions AS (
          SELECT
            fen.date,
            fen.nutrient_id,
            fen.amount,
            fen.provider_id,
            CASE
              WHEN fen.supplement_dose_event_id IS NOT NULL THEN 'supplement'
              WHEN classification.effective_grain = 'itemized' THEN 'itemized_food'
              WHEN classification.effective_grain = 'meal_aggregate' THEN 'meal_aggregate'
              ELSE 'provider_daily_total'
            END AS intake_type,
            COALESCE(
              classification.source_label,
              NULLIF(BTRIM(supplement_event.source_name), ''),
              fen.provider_id
            ) AS source_label
          FROM fitness.v_nutrition_canonical_nutrient AS fen
          LEFT JOIN fitness.v_nutrition_entry_classification AS classification
            ON classification.id = fen.food_entry_id
          LEFT JOIN fitness.v_supplement_dose_current AS supplement_event
            ON supplement_event.id = fen.supplement_dose_event_id
          WHERE fen.user_id = ${options.userId}
            ${currentDateRangePredicate(sql`fen.date`, options.days)}
            ${options.dateAccessPredicate}
        ),
        daily_totals AS (
          SELECT
            contribution.date,
            n.id,
            n.display_name,
            n.unit,
            SUM(contribution.amount) AS total_amount,
            COALESCE(
              SUM(contribution.amount)
                FILTER (WHERE contribution.intake_type IN ('itemized_food', 'meal_aggregate')),
              0
            ) AS food_amount,
            COALESCE(
              SUM(contribution.amount)
                FILTER (WHERE contribution.intake_type = 'provider_daily_total'),
              0
            ) AS provider_daily_total_amount,
            COALESCE(
              SUM(contribution.amount)
                FILTER (WHERE contribution.intake_type = 'supplement'),
              0
            ) AS supplement_amount
          FROM contributions AS contribution
          JOIN fitness.nutrient AS n ON n.id = contribution.nutrient_id
          GROUP BY contribution.date, n.id, n.display_name, n.unit
        ),
        nutrient_summary AS (
          SELECT
            id,
            display_name,
            unit,
            AVG(total_amount) AS avg_total_intake,
            AVG(food_amount) AS avg_food_intake,
            AVG(provider_daily_total_amount) AS avg_provider_daily_total_intake,
            AVG(supplement_amount) AS avg_supplement_intake,
            COUNT(total_amount)::integer AS days_tracked
          FROM daily_totals
          GROUP BY id, display_name, unit
        ),
        source_daily AS (
          SELECT
            date,
            nutrient_id,
            provider_id,
            source_label,
            intake_type,
            SUM(amount) AS source_amount
          FROM contributions
          GROUP BY date, nutrient_id, provider_id, source_label, intake_type
        ),
        source_summary AS (
          SELECT
            nutrient_id,
            provider_id,
            source_label,
            intake_type,
            SUM(source_amount) AS total_amount,
            COUNT(*)::integer AS days_tracked
          FROM source_daily
          GROUP BY nutrient_id, provider_id, source_label, intake_type
        ),
        source_breakdowns AS (
          SELECT
            source.nutrient_id,
            JSONB_AGG(
              JSONB_BUILD_OBJECT(
                'providerId', source.provider_id,
                'sourceLabel', source.source_label,
                'intakeType', source.intake_type,
                'dailyAverageContribution',
                  source.total_amount / NULLIF(summary.days_tracked, 0),
                'daysTracked', source.days_tracked
              )
              ORDER BY source.intake_type, source.source_label, source.provider_id
            ) AS sources
          FROM source_summary AS source
          JOIN nutrient_summary AS summary ON summary.id = source.nutrient_id
          GROUP BY source.nutrient_id
        )
        SELECT
          summary.id AS nutrient_id,
          summary.display_name AS nutrient,
          summary.unit,
          summary.avg_total_intake,
          summary.avg_food_intake,
          summary.avg_provider_daily_total_intake,
          summary.avg_supplement_intake,
          summary.days_tracked,
          COALESCE(source_breakdowns.sources, '[]'::jsonb) AS source_breakdown
        FROM nutrient_summary AS summary
        LEFT JOIN source_breakdowns ON source_breakdowns.nutrient_id = summary.id
        ORDER BY summary.display_name`,
  );

  return rows.flatMap((row) => {
    const upperLimit = evaluateNutrientUpperLimit({
      nutrientId: row.nutrient_id,
      unit: row.unit,
      totalDailyAmount: row.avg_total_intake,
      supplementalDailyAmount: row.avg_supplement_intake,
    });
    if (getNutrientDailyValue(row.nutrient_id) == null && upperLimit.status === "not_in_ruleset") {
      return [];
    }

    return [
      new MicronutrientSafetyReview({
        nutrientId: row.nutrient_id,
        nutrient: row.nutrient,
        unit: row.unit,
        totalDailyAverage: row.avg_total_intake,
        foodDailyAverage: row.avg_food_intake,
        providerDailyTotalAverage: row.avg_provider_daily_total_intake,
        supplementDailyAverage: row.avg_supplement_intake,
        daysTracked: row.days_tracked,
        sourceBreakdown: row.source_breakdown,
      }),
    ];
  });
}
