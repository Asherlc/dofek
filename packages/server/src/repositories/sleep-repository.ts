import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import { BaseRepository } from "../lib/base-repository.ts";
import type { RangeDays } from "../lib/date-window.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { fetchLatestSleepNight, fetchSleepNights } from "./clickhouse-sleep-repository.ts";

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
  readonly #sensorStore?: ActivitySensorStore;

  constructor(
    db: Pick<Database, "execute">,
    userId: string,
    timezone = "UTC",
    accessWindow?: AccessWindow,
    sensorStore?: ActivitySensorStore,
  ) {
    super(db, userId, timezone, accessWindow);
    this.#sensorStore = sensorStore;
  }

  #requireSensorStore(): ActivitySensorStore {
    if (!this.#sensorStore) {
      throw new Error("SleepRepository requires the ClickHouse activity analytics store");
    }
    return this.#sensorStore;
  }

  /** All sleep sessions within the given day window, deduplicated per calendar date, oldest first. */
  async list(days: RangeDays, endDate: string) {
    return fetchSleepNights({
      sensorStore: this.#requireSensorStore(),
      userId: this.userId,
      timezone: this.timezone,
      endDate,
      days,
      accessWindow: this.accessWindow,
      order: "asc",
    });
  }

  /** Sleep sessions inside an exact inclusive date range. */
  async listRange(startDate: string, endDate: string) {
    const start = new Date(`${startDate}T00:00:00Z`);
    const end = new Date(`${endDate}T00:00:00Z`);
    const days = Math.round((end.getTime() - start.getTime()) / 86_400_000);
    return this.list(days, endDate);
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
					JOIN fitness.sleep_session ss ON ss.id = st.session_id
					WHERE ss.id = ${sessionId}
						AND ss.user_id = ${this.userId}
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
   * multiple hours on when the night started, so match on true overlapping
   * session windows instead of only comparing start times.
   */
  async getLatestStages() {
    const latestSleep = await fetchLatestSleepNight({
      sensorStore: this.#requireSensorStore(),
      userId: this.userId,
      timezone: this.timezone,
      accessWindow: this.accessWindow,
    });
    if (!latestSleep) return [];

    return this.query(
      sleepStageRowSchema,
      sql`WITH best_stage_session AS (
						SELECT ss.id
						FROM fitness.sleep_session ss
						WHERE ss.user_id = ${this.userId}
							AND ss.started_at <= COALESCE(${latestSleep.ended_at}::timestamptz, ${latestSleep.started_at}::timestamptz + interval '12 hours')
							AND COALESCE(ss.ended_at, ss.started_at + interval '12 hours') >= ${latestSleep.started_at}::timestamptz
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
    return fetchLatestSleepNight({
      sensorStore: this.#requireSensorStore(),
      userId: this.userId,
      timezone: this.timezone,
      accessWindow: this.accessWindow,
    });
  }
}
