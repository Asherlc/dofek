import { formatReadinessDifference } from "@dofek/format/format";
import { type ProviderProvenance, resolveProviderProvenance } from "@dofek/providers/providers";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  currentDateRangePredicate,
  type RangeDays,
  rangeDaysOrNullAdd,
} from "../lib/date-window.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { fetchRestingHeartRateValuesCte } from "./resting-heart-rate-query.ts";

// ---------------------------------------------------------------------------
// Domain model
// ---------------------------------------------------------------------------

export interface BehaviorImpactRow {
  questionSlug: string;
  displayName: string;
  category: string;
  avgReadinessYes: number;
  avgReadinessNo: number;
  yesCount: number;
  noCount: number;
  providerIds: string[];
}

export type BehaviorAssociationDirection = "higher" | "lower" | "no_difference";

export interface BehaviorAssociationSemantics {
  relationship: "descriptive_association";
  direction: BehaviorAssociationDirection;
  estimateLabel: string;
  method: string;
  interpretation: string;
  uncertainty: string;
}

const BEHAVIOR_ASSOCIATION_METHOD =
  "Relative difference in mean next-day readiness after Yes versus No.";
const BEHAVIOR_ASSOCIATION_INTERPRETATION =
  "This observational association does not establish that the behavior caused the readiness difference or prescribe a behavior change.";
const BEHAVIOR_ASSOCIATION_UNCERTAINTY =
  "Uncertainty interval is unavailable for this descriptive comparison.";

/** A descriptive association between a boolean journal behavior and next-day readiness. */
export class BehaviorImpact {
  readonly #row: BehaviorImpactRow;

  constructor(row: BehaviorImpactRow) {
    this.#row = row;
  }

  get questionSlug(): string {
    return this.#row.questionSlug;
  }

  get displayName(): string {
    return this.#row.displayName;
  }

  get category(): string {
    return this.#row.category;
  }

  get yesCount(): number {
    return this.#row.yesCount;
  }

  get noCount(): number {
    return this.#row.noCount;
  }

  get sources(): ProviderProvenance[] {
    return [...new Set(this.#row.providerIds)]
      .sort((left, right) => left.localeCompare(right))
      .map(resolveProviderProvenance);
  }

  /** Relative difference in mean next-day readiness when behavior=yes versus no. */
  get impactPercent(): number {
    if (this.#row.avgReadinessNo === 0) return 0;
    return (
      Math.round(
        ((this.#row.avgReadinessYes - this.#row.avgReadinessNo) / this.#row.avgReadinessNo) * 1000,
      ) / 10
    );
  }

  get association(): BehaviorAssociationSemantics {
    const impactPercent = this.impactPercent;
    const direction: BehaviorAssociationDirection =
      impactPercent > 0 ? "higher" : impactPercent < 0 ? "lower" : "no_difference";

    return {
      relationship: "descriptive_association",
      direction,
      estimateLabel: formatReadinessDifference(impactPercent),
      method: BEHAVIOR_ASSOCIATION_METHOD,
      interpretation: BEHAVIOR_ASSOCIATION_INTERPRETATION,
      uncertainty: BEHAVIOR_ASSOCIATION_UNCERTAINTY,
    };
  }

  toDetail() {
    return {
      questionSlug: this.questionSlug,
      displayName: this.displayName,
      category: this.category,
      impactPercent: this.impactPercent,
      yesCount: this.yesCount,
      noCount: this.noCount,
      sources: this.sources,
      association: this.association,
    };
  }
}

// ---------------------------------------------------------------------------
// Zod schema for raw DB rows
// ---------------------------------------------------------------------------

const impactDbSchema = z.object({
  question_slug: z.string(),
  display_name: z.string(),
  category: z.string(),
  avg_readiness_yes: z.coerce.number(),
  avg_readiness_no: z.coerce.number(),
  yes_count: z.coerce.number(),
  no_count: z.coerce.number(),
  provider_ids: z.array(z.string()).min(1),
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for descriptive behavior/readiness associations. */
export class BehaviorImpactRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;
  readonly #timezone: string;
  readonly #sensorStore?: Pick<ActivitySensorStore, "query">;

  constructor(
    db: Pick<Database, "execute">,
    userId: string,
    timezone: string,
    sensorStore?: Pick<ActivitySensorStore, "query">,
  ) {
    this.#db = db;
    this.#userId = userId;
    this.#timezone = timezone;
    this.#sensorStore = sensorStore;
  }

  /** Descriptive associations between boolean journal behaviors and next-day readiness. */
  async getImpactSummary(days: RangeDays): Promise<BehaviorImpact[]> {
    const sensorStore = this.#requireSensorStore();
    const restingHeartRateCte = await fetchRestingHeartRateValuesCte({
      sensorStore,
      userId: this.#userId,
      timezone: this.#timezone,
      endDate: new Date().toISOString().slice(0, 10),
      days: rangeDaysOrNullAdd(days, 1),
    });
    const rows = await executeWithSchema(
      this.#db,
      impactDbSchema,
      sql`WITH ${restingHeartRateCte},
          boolean_entries AS (
            SELECT
              je.date,
              je.question_slug,
              je.provider_id,
              jq.display_name,
              jq.category,
              CASE
                WHEN je.answer_text = 'yes' OR je.answer_numeric = 1 THEN true
                WHEN je.answer_text = 'no' OR je.answer_numeric = 0 THEN false
                ELSE NULL
              END AS answer_bool
            FROM fitness.journal_entry je
            JOIN fitness.journal_question jq ON jq.slug = je.question_slug
            WHERE je.user_id = ${this.#userId}
              ${currentDateRangePredicate(sql`je.date`, days, ">=")}
              AND jq.data_type = 'boolean'
          ),
          readiness AS (
            SELECT
              dm.date,
              AVG(
                CASE
                  WHEN drhr.resting_hr IS NOT NULL AND dm.hrv IS NOT NULL
                  THEN (100 - LEAST(drhr.resting_hr, 100)) * 0.5 + LEAST(dm.hrv / 2.0, 50)
                  WHEN drhr.resting_hr IS NOT NULL
                  THEN 100 - LEAST(drhr.resting_hr, 100)
                  WHEN dm.hrv IS NOT NULL
                  THEN LEAST(dm.hrv, 100)
                  ELSE NULL
                END
              ) AS readiness_score
	            FROM fitness.v_daily_metrics dm
	            LEFT JOIN resting_heart_rate drhr
	              ON drhr.date = dm.date
            WHERE dm.user_id = ${this.#userId}
              ${currentDateRangePredicate(sql`dm.date`, days, ">=")}
            GROUP BY dm.date
          ),
          joined AS (
            SELECT
              be.question_slug,
              be.provider_id,
              be.display_name,
              be.category,
              be.answer_bool,
              r.readiness_score
            FROM boolean_entries be
            JOIN readiness r ON r.date = be.date + 1
            WHERE be.answer_bool IS NOT NULL
              AND r.readiness_score IS NOT NULL
          )
          SELECT
            question_slug,
            display_name,
            category,
            AVG(CASE WHEN answer_bool = true THEN readiness_score END) AS avg_readiness_yes,
            AVG(CASE WHEN answer_bool = false THEN readiness_score END) AS avg_readiness_no,
            COUNT(CASE WHEN answer_bool = true THEN 1 END)::int AS yes_count,
            COUNT(CASE WHEN answer_bool = false THEN 1 END)::int AS no_count,
            ARRAY_AGG(DISTINCT provider_id ORDER BY provider_id) AS provider_ids
          FROM joined
          GROUP BY question_slug, display_name, category
          HAVING COUNT(CASE WHEN answer_bool = true THEN 1 END) >= 5
             AND COUNT(CASE WHEN answer_bool = false THEN 1 END) >= 5
          ORDER BY ABS(AVG(CASE WHEN answer_bool = true THEN readiness_score END)
                    - AVG(CASE WHEN answer_bool = false THEN readiness_score END)) DESC`,
    );

    return rows.map(
      (row) =>
        new BehaviorImpact({
          questionSlug: row.question_slug,
          displayName: row.display_name,
          category: row.category,
          avgReadinessYes: Number(row.avg_readiness_yes),
          avgReadinessNo: Number(row.avg_readiness_no),
          yesCount: Number(row.yes_count),
          noCount: Number(row.no_count),
          providerIds: row.provider_ids,
        }),
    );
  }

  #requireSensorStore(): Pick<ActivitySensorStore, "query"> {
    if (!this.#sensorStore) {
      throw new Error("ClickHouse activity analytics store is required for behavior impact");
    }
    return this.#sensorStore;
  }
}
