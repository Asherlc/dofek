import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { timestampWindowStart } from "../lib/date-window.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";

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
  stage: z.string(),
  started_at: z.string(),
  ended_at: z.string(),
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for sleep session records. */
export class SleepRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;
  readonly #timezone: string;

  constructor(db: Pick<Database, "execute">, userId: string, timezone: string) {
    this.#db = db;
    this.#userId = userId;
    this.#timezone = timezone;
  }

  /** All sleep sessions within the given day window, deduplicated per calendar date, oldest first. */
  async list(days: number, endDate: string) {
    return executeWithSchema(
      this.#db,
      sleepListRowSchema,
      sql`WITH raw_sleep AS (
						SELECT
							(started_at AT TIME ZONE ${this.#timezone})::date AS sleep_date,
							duration_minutes, deep_minutes, rem_minutes, light_minutes, awake_minutes, efficiency_pct
						FROM fitness.v_sleep
						WHERE user_id = ${this.#userId}
							AND is_nap = false
							AND started_at > ${timestampWindowStart(endDate, days)}
					),
					deduped AS (
						SELECT DISTINCT ON (sleep_date)
							sleep_date, duration_minutes, deep_minutes, rem_minutes, light_minutes, awake_minutes, efficiency_pct
						FROM raw_sleep
						ORDER BY sleep_date, duration_minutes DESC NULLS LAST
					)
					SELECT
						to_char(sleep_date, 'YYYY-MM-DD"T"12:00:00') AS started_at,
						duration_minutes, deep_minutes, rem_minutes, light_minutes, awake_minutes, efficiency_pct
					FROM deduped
					ORDER BY sleep_date ASC`,
    );
  }

  /** Sleep stages for a specific session. */
  async getStages(sessionId: string) {
    return executeWithSchema(
      this.#db,
      sleepStageRowSchema,
      sql`SELECT
						st.stage,
						to_char(st.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS started_at,
						to_char(st.ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ended_at
					FROM fitness.sleep_stage st
					JOIN fitness.v_sleep vs ON vs.id = st.session_id
					WHERE vs.id = ${sessionId}
						AND vs.user_id = ${this.#userId}
					ORDER BY st.started_at ASC`,
    );
  }

  /**
   * Sleep stages for the most recent non-nap session.
   *
   * The winning session in v_sleep may come from a provider that doesn't store
   * individual stage transitions (e.g. WHOOP only stores aggregate minutes).
   * When that happens, we fall back to any overlapping raw session that does
   * have stages — e.g. from Apple Health or Garmin.
   */
  async getLatestStages() {
    return executeWithSchema(
      this.#db,
      sleepStageRowSchema,
      sql`WITH latest_sleep AS (
						SELECT started_at, ended_at
						FROM fitness.v_sleep
						WHERE user_id = ${this.#userId} AND is_nap = false
						ORDER BY started_at DESC
						LIMIT 1
					),
					best_stage_session AS (
						SELECT ss.id
						FROM fitness.sleep_session ss, latest_sleep ls
						WHERE ss.user_id = ${this.#userId}
							AND ss.started_at BETWEEN ls.started_at - interval '2 hours'
								AND COALESCE(ls.ended_at, ls.started_at + interval '12 hours')
							AND EXISTS (SELECT 1 FROM fitness.sleep_stage s2 WHERE s2.session_id = ss.id)
						ORDER BY (SELECT count(*) FROM fitness.sleep_stage s3 WHERE s3.session_id = ss.id) DESC
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
    const rows = await executeWithSchema(
      this.#db,
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
					WHERE user_id = ${this.#userId}
						AND is_nap = false
					ORDER BY started_at DESC LIMIT 1`,
    );
    return rows[0] ?? null;
  }
}
