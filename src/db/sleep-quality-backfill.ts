import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";
import type { Database } from "./index.ts";

const resultRowSchema = z.object({
  rows_changed: z.number(),
  staging_marked_available: z.number(),
  stage_values_cleared: z.number(),
  apple_efficiency_cleared: z.number(),
});

export interface SleepQualityBackfillResult {
  rowsChanged: number;
  stagingMarkedAvailable: number;
  stageValuesCleared: number;
  appleEfficiencyCleared: number;
}

export interface SleepQualityBackfillOptions {
  execute: boolean;
  start: Date;
  end: Date;
}

export async function backfillSleepQuality(
  db: Pick<Database, "execute">,
  options: SleepQualityBackfillOptions,
): Promise<SleepQualityBackfillResult> {
  const candidateRows = sql`
    WITH window_sessions AS (
      SELECT *
      FROM fitness.sleep_session
      WHERE started_at >= ${options.start}
        AND started_at < ${options.end}
    ),
    stage_evidence AS (
      SELECT
        stage.session_id,
        BOOL_OR(stage.stage IN ('deep', 'rem')) AS has_distinct_staging,
        BOOL_OR(stage.stage = 'awake') AS has_awake
      FROM fitness.sleep_stage AS stage
      INNER JOIN window_sessions AS session ON session.id = stage.session_id
      GROUP BY stage.session_id
    ),
    candidates AS (
      SELECT
        session.id,
        CASE
          WHEN session.provider_id = 'apple_health' THEN
            COALESCE(stage_evidence.has_distinct_staging, false)
          ELSE
            session.deep_minutes IS NOT NULL
            AND session.rem_minutes IS NOT NULL
            AND session.light_minutes IS NOT NULL
            AND session.awake_minutes IS NOT NULL
            AND (
              session.deep_minutes <> 0
              OR session.rem_minutes <> 0
              OR session.light_minutes <> 0
              OR session.awake_minutes <> 0
            )
        END AS desired_staging_available,
        CASE
          WHEN session.provider_id = 'apple_health'
            AND NOT COALESCE(stage_evidence.has_distinct_staging, false)
            THEN true
          WHEN session.provider_id IN ('garmin', 'whoop')
            AND session.deep_minutes = 0
            AND session.rem_minutes = 0
            AND session.light_minutes = 0
            AND session.awake_minutes = 0
            THEN true
          ELSE false
        END AS should_clear_stages,
        CASE
          WHEN session.provider_id = 'apple_health'
            AND NOT COALESCE(stage_evidence.has_distinct_staging, false)
            AND NOT COALESCE(stage_evidence.has_awake, false)
            THEN true
          WHEN session.provider_id IN ('garmin', 'whoop')
            AND session.deep_minutes = 0
            AND session.rem_minutes = 0
            AND session.light_minutes = 0
            AND session.awake_minutes = 0
            THEN true
          ELSE false
        END AS should_clear_awake,
        session.provider_id = 'apple_health' AND session.efficiency_pct IS NOT NULL
          AS should_clear_apple_efficiency,
        session.staging_available,
        session.deep_minutes,
        session.rem_minutes,
        session.light_minutes,
        session.awake_minutes,
        session.efficiency_pct
      FROM window_sessions AS session
      LEFT JOIN stage_evidence ON stage_evidence.session_id = session.id
    )
  `;

  const rows = options.execute
    ? await executeWithSchema(
        db,
        resultRowSchema,
        sql`
          ${candidateRows},
          updated AS (
            UPDATE fitness.sleep_session AS session
            SET
              staging_available = candidates.desired_staging_available,
              deep_minutes = CASE WHEN candidates.should_clear_stages THEN NULL
                ELSE session.deep_minutes END,
              rem_minutes = CASE WHEN candidates.should_clear_stages THEN NULL
                ELSE session.rem_minutes END,
              light_minutes = CASE WHEN candidates.should_clear_stages THEN NULL
                ELSE session.light_minutes END,
              awake_minutes = CASE WHEN candidates.should_clear_awake THEN NULL
                ELSE session.awake_minutes END,
              efficiency_pct = CASE WHEN candidates.should_clear_apple_efficiency THEN NULL
                ELSE session.efficiency_pct END
            FROM candidates
            WHERE session.id = candidates.id
              AND (
                session.staging_available IS DISTINCT FROM candidates.desired_staging_available
                OR (candidates.should_clear_stages AND (
                  session.deep_minutes IS NOT NULL
                  OR session.rem_minutes IS NOT NULL
                  OR session.light_minutes IS NOT NULL
                  OR (candidates.should_clear_awake AND session.awake_minutes IS NOT NULL)
                ))
                OR candidates.should_clear_apple_efficiency
              )
            RETURNING
              (
                candidates.desired_staging_available
                AND candidates.staging_available IS DISTINCT FROM true
              ) AS staging_marked_available,
              (
                candidates.should_clear_stages
                AND (
                  candidates.deep_minutes IS NOT NULL
                  OR candidates.rem_minutes IS NOT NULL
                  OR candidates.light_minutes IS NOT NULL
                  OR (
                    candidates.should_clear_awake
                    AND candidates.awake_minutes IS NOT NULL
                  )
                )
              ) AS stage_values_cleared,
              candidates.should_clear_apple_efficiency
          )
          SELECT
            COUNT(*)::int AS rows_changed,
            COUNT(*) FILTER (WHERE staging_marked_available)::int
              AS staging_marked_available,
            COUNT(*) FILTER (WHERE stage_values_cleared)::int AS stage_values_cleared,
            COUNT(*) FILTER (WHERE should_clear_apple_efficiency)::int
              AS apple_efficiency_cleared
          FROM updated
        `,
      )
    : await executeWithSchema(
        db,
        resultRowSchema,
        sql`
          ${candidateRows}
          SELECT
            COUNT(*) FILTER (
              WHERE staging_available IS DISTINCT FROM desired_staging_available
                OR (should_clear_stages AND (
                  deep_minutes IS NOT NULL
                  OR rem_minutes IS NOT NULL
                  OR light_minutes IS NOT NULL
                  OR (should_clear_awake AND awake_minutes IS NOT NULL)
                ))
                OR should_clear_apple_efficiency
            )::int AS rows_changed,
            COUNT(*) FILTER (
              WHERE desired_staging_available
                AND staging_available IS DISTINCT FROM true
            )::int AS staging_marked_available,
            COUNT(*) FILTER (
              WHERE should_clear_stages
                AND (
                  deep_minutes IS NOT NULL
                  OR rem_minutes IS NOT NULL
                  OR light_minutes IS NOT NULL
                  OR (should_clear_awake AND awake_minutes IS NOT NULL)
                )
            )::int AS stage_values_cleared,
            COUNT(*) FILTER (WHERE should_clear_apple_efficiency)::int
              AS apple_efficiency_cleared
          FROM candidates
        `,
      );

  const [row] = rows;
  if (!row || rows.length !== 1) {
    throw new Error("Expected one sleep quality backfill result row");
  }

  return {
    rowsChanged: row.rows_changed,
    stagingMarkedAvailable: row.staging_marked_available,
    stageValuesCleared: row.stage_values_cleared,
    appleEfficiencyCleared: row.apple_efficiency_cleared,
  };
}
