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

	/** All sleep sessions within the given day window, oldest first. */
	async list(days: number, endDate: string) {
		return executeWithSchema(
			this.#db,
			sleepListRowSchema,
			sql`SELECT
						to_char(started_at AT TIME ZONE ${this.#timezone}, 'YYYY-MM-DD"T"HH24:MI:SS') AS started_at,
						duration_minutes,
						deep_minutes,
						rem_minutes,
						light_minutes,
						awake_minutes,
						efficiency_pct
					FROM fitness.v_sleep
					WHERE user_id = ${this.#userId}
						AND started_at > ${timestampWindowStart(endDate, days)}
					ORDER BY started_at ASC`,
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

	/** Sleep stages for the most recent non-nap session. */
	async getLatestStages() {
		return executeWithSchema(
			this.#db,
			sleepStageRowSchema,
			sql`SELECT
						st.stage,
						to_char(st.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS started_at,
						to_char(st.ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ended_at
					FROM fitness.sleep_stage st
					WHERE st.session_id = (
						SELECT vs.id FROM fitness.v_sleep vs
						WHERE vs.user_id = ${this.#userId}
							AND vs.is_nap = false
						ORDER BY vs.started_at DESC
						LIMIT 1
					)
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
