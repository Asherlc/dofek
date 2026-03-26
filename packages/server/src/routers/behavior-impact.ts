import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export interface BehaviorImpact {
  questionSlug: string;
  displayName: string;
  category: string;
  /** Percentage change in next-day readiness when behavior=yes vs no */
  impactPercent: number;
  yesCount: number;
  noCount: number;
}

const impactRowSchema = z.object({
  question_slug: z.string(),
  display_name: z.string(),
  category: z.string(),
  avg_readiness_yes: z.coerce.number(),
  avg_readiness_no: z.coerce.number(),
  yes_count: z.coerce.number(),
  no_count: z.coerce.number(),
});

export const behaviorImpactRouter = router({
  /**
   * Behavior Impact Summary — for each boolean journal question, compute the
   * average next-day readiness when behavior=yes vs no.
   * Only includes questions with at least 5 yes + 5 no entries.
   */
  impactSummary: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().min(7).max(365).default(90) }))
    .query(async ({ ctx, input }): Promise<BehaviorImpact[]> => {
      const rows = await executeWithSchema(
        ctx.db,
        impactRowSchema,
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
              WHERE je.user_id = ${ctx.userId}
                AND je.date >= (CURRENT_DATE - ${input.days}::int)
                AND jq.data_type = 'boolean'
            ),
            readiness AS (
              SELECT
                date,
                AVG(
                  CASE
                    WHEN resting_hr IS NOT NULL AND hrv IS NOT NULL
                    THEN (100 - LEAST(resting_hr, 100)) * 0.5 + LEAST(hrv / 2.0, 50)
                    WHEN resting_hr IS NOT NULL
                    THEN 100 - LEAST(resting_hr, 100)
                    WHEN hrv IS NOT NULL
                    THEN LEAST(hrv, 100)
                    ELSE NULL
                  END
                ) AS readiness_score
              FROM fitness.v_daily_metrics
              WHERE user_id = ${ctx.userId}
                AND date >= (CURRENT_DATE - ${input.days}::int)
              GROUP BY date
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

      return rows.map((row) => {
        const avgYes = Number(row.avg_readiness_yes);
        const avgNo = Number(row.avg_readiness_no);
        const impactPercent = avgNo !== 0 ? Math.round(((avgYes - avgNo) / avgNo) * 1000) / 10 : 0;

        return {
          questionSlug: row.question_slug,
          displayName: row.display_name,
          category: row.category,
          impactPercent,
          yesCount: Number(row.yes_count),
          noCount: Number(row.no_count),
        };
      });
    }),
});
