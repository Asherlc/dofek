import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";

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
}

/** A boolean journal behavior and its measured impact on next-day readiness. */
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

  /** Percentage change in next-day readiness when behavior=yes vs no. */
  get impactPercent(): number {
    if (this.#row.avgReadinessNo === 0) return 0;
    return (
      Math.round(
        ((this.#row.avgReadinessYes - this.#row.avgReadinessNo) / this.#row.avgReadinessNo) * 1000,
      ) / 10
    );
  }

  toDetail() {
    return {
      questionSlug: this.questionSlug,
      displayName: this.displayName,
      category: this.category,
      impactPercent: this.impactPercent,
      yesCount: this.yesCount,
      noCount: this.noCount,
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
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for behavior-impact-on-readiness analytics. */
export class BehaviorImpactRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;

  constructor(db: Pick<Database, "execute">, userId: string, _timezone: string) {
    this.#db = db;
    this.#userId = userId;
  }

  /** Impact of boolean journal behaviors on next-day readiness. */
  async getImpactSummary(days: number): Promise<BehaviorImpact[]> {
    const rows = await executeWithSchema(
      this.#db,
      impactDbSchema,
      sql`WITH boolean_entries AS (
            SELECT
              je.date,
              je.question_slug,
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
              AND je.date >= (CURRENT_DATE - ${days}::int)
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
            LEFT JOIN fitness.derived_resting_heart_rate drhr
              ON drhr.user_id = dm.user_id
             AND drhr.date = dm.date
            WHERE dm.user_id = ${this.#userId}
              AND dm.date >= (CURRENT_DATE - ${days}::int)
            GROUP BY dm.date
          ),
          joined AS (
            SELECT
              be.question_slug,
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
            COUNT(CASE WHEN answer_bool = false THEN 1 END)::int AS no_count
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
        }),
    );
  }
}
