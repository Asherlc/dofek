import { sql } from "drizzle-orm";
import { z } from "zod";
import { BaseRepository } from "../lib/base-repository.ts";
import { sleepDedupCte } from "../lib/sql-fragments.ts";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

export const sleepListRowSchema = z.object({
  started_at: z.string(),
  duration_minutes: z.coerce.number().nullable(),
  deep_minutes: z.coerce.number().nullable(),
  rem_minutes: z.coerce.number().nullable(),
  light_minutes: z.coerce.number().nullable(),
  awake_minutes: z.coerce.number().nullable(),
  efficiency_pct: z.coerce.number().nullable(),
});

const sleepStageRowSchema = z.object({
  stage: z.enum(["deep", "light", "rem", "awake"]),
  started_at: z.string(),
  ended_at: z.string(),
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for sleep session records. */
export class SleepRepository extends BaseRepository {
  /** All sleep sessions within the given day window, deduplicated per calendar date, oldest first. */
  async list(days: number, endDate: string) {
    return this.query(
      sleepListRowSchema,
      sql`WITH ${sleepDedupCte(this.userId, this.timezone, endDate, days)}
					SELECT
						to_char(sleep_date, 'YYYY-MM-DD"T"12:00:00') AS started_at,
						duration_minutes, deep_minutes, rem_minutes, light_minutes, awake_minutes, efficiency_pct
					FROM sleep_deduped
					ORDER BY sleep_date ASC`,
    );
  }

  /** Sleep stages for a specific session. */
  async getStages(sessionId: string) {
    return this.query(
      sleepStageRowSchema,
      sql`SELECT
						st.stage,
						to_char(st.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS started_at,
						to_char(st.ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ended_at
					FROM fitness.sleep_stage st
					JOIN fitness.v_sleep vs ON vs.id = st.session_id
					WHERE vs.id = ${sessionId}
						AND vs.user_id = ${this.userId}
					ORDER BY st.started_at ASC`,
    );
  }

  /**
   * Sleep stages for the most recent non-nap session.
   *
   * The winning session in v_sleep may come from a provider that doesn't store
   * individual stage transitions (e.g. WHOOP only stores aggregate minutes).
   * When that happens, we fall back to any overlapping raw session that does
   * have stages — e.g. from Apple Health or Garmin. Providers can disagree by
   * multiple hours on when the night started, so match on overlapping session
   * windows instead of only comparing start times.
   */
  async getLatestStages() {
    return this.query(
      sleepStageRowSchema,
      sql`WITH latest_sleep AS (
						SELECT
							started_at,
							COALESCE(ended_at, started_at + interval '12 hours') AS ended_at
						FROM fitness.v_sleep
						WHERE user_id = ${this.userId} AND is_nap = false
						ORDER BY started_at DESC
						LIMIT 1
					),
					best_stage_session AS (
						SELECT ss.id
						FROM fitness.sleep_session ss, latest_sleep ls
						WHERE ss.user_id = ${this.userId}
							AND ss.started_at <= ls.ended_at + interval '2 hours'
							AND COALESCE(ss.ended_at, ss.started_at + interval '12 hours') >= ls.started_at - interval '2 hours'
							AND EXISTS (SELECT 1 FROM fitness.sleep_stage s2 WHERE s2.session_id = ss.id)
						ORDER BY
							(SELECT count(*) FROM fitness.sleep_stage s3 WHERE s3.session_id = ss.id) DESC,
							ss.started_at DESC
						LIMIT 1
					)
					SELECT
						st.stage,
						to_char(st.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS started_at,
						to_char(st.ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ended_at
					FROM fitness.sleep_stage st
					WHERE st.session_id = (SELECT id FROM best_stage_session)
					ORDER BY st.started_at ASC`,
    );
  }

  /** The most recent non-nap sleep session, or null if none exists. */
  async getLatest() {
    const rows = await this.query(
      sleepListRowSchema,
      sql`SELECT
						to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS started_at,
						duration_minutes,
						deep_minutes,
						rem_minutes,
						light_minutes,
						awake_minutes,
						efficiency_pct
					FROM fitness.v_sleep
					WHERE user_id = ${this.userId}
						AND is_nap = false
					ORDER BY started_at DESC LIMIT 1`,
    );
    return rows[0] ?? null;
  }
}
