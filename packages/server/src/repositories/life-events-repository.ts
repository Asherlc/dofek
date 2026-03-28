import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";

// ---------------------------------------------------------------------------
// Zod schemas for raw DB rows
// ---------------------------------------------------------------------------

const lifeEventRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  category: z.string().nullable(),
  ongoing: z.coerce.boolean(),
  notes: z.string().nullable(),
  created_at: z.string(),
});

/** Schema for life event rows from RETURNING * (includes user_id) */
const lifeEventFullRowSchema = lifeEventRowSchema.extend({
  user_id: z.string(),
});

const metricsComparisonRowSchema = z.object({
  period: z.string(),
  days: z.coerce.number(),
  avg_resting_hr: z.coerce.number().nullable(),
  avg_hrv: z.coerce.number().nullable(),
  avg_steps: z.coerce.number().nullable(),
  avg_active_energy: z.coerce.number().nullable(),
});

const sleepComparisonRowSchema = z.object({
  period: z.string(),
  nights: z.coerce.number(),
  avg_sleep_min: z.coerce.number().nullable(),
  avg_deep_min: z.coerce.number().nullable(),
  avg_rem_min: z.coerce.number().nullable(),
  avg_efficiency: z.coerce.number().nullable(),
});

const bodyComparisonRowSchema = z.object({
  period: z.string(),
  measurements: z.coerce.number(),
  avg_weight: z.coerce.number().nullable(),
  avg_body_fat: z.coerce.number().nullable(),
});

const lifeEventLookupSchema = z
  .object({
    started_at: z.string(),
    ended_at: z.string().nullable(),
    ongoing: z.boolean(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LifeEventRow = z.infer<typeof lifeEventRowSchema>;
export type LifeEventFullRow = z.infer<typeof lifeEventFullRowSchema>;
export type MetricsComparison = z.infer<typeof metricsComparisonRowSchema>;
export type SleepComparison = z.infer<typeof sleepComparisonRowSchema>;
export type BodyComparison = z.infer<typeof bodyComparisonRowSchema>;

export interface CreateLifeEventInput {
  label: string;
  startedAt: string;
  endedAt: string | null;
  category: string | null;
  ongoing: boolean;
  notes: string | null;
}

export interface UpdateLifeEventInput {
  label?: string;
  startedAt?: string;
  endedAt?: string | null;
  category?: string | null;
  ongoing?: boolean;
  notes?: string | null;
}

export interface AnalyzeResult {
  event: Record<string, unknown>;
  metrics: MetricsComparison[];
  sleep: SleepComparison[];
  bodyComp: BodyComparison[];
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for life events and before/after analysis. */
export class LifeEventsRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;
  readonly #timezone: string;

  constructor(db: Pick<Database, "execute">, userId: string, timezone: string) {
    this.#db = db;
    this.#userId = userId;
    this.#timezone = timezone;
  }

  /** List all life events for the user, ordered by start date descending. */
  async list(): Promise<LifeEventRow[]> {
    return executeWithSchema(
      this.#db,
      lifeEventRowSchema,
      sql`SELECT id, label, started_at, ended_at, category, ongoing, notes, created_at
				FROM fitness.life_events
				WHERE user_id = ${this.#userId}
				ORDER BY started_at DESC`,
    );
  }

  /** Create a new life event, returning the full row. */
  async create(input: CreateLifeEventInput): Promise<LifeEventFullRow> {
    const rows = await executeWithSchema(
      this.#db,
      lifeEventFullRowSchema,
      sql`INSERT INTO fitness.life_events (user_id, label, started_at, ended_at, category, ongoing, notes)
				VALUES (${this.#userId}, ${input.label}, ${input.startedAt}::date, ${input.endedAt}::date, ${input.category}, ${input.ongoing}, ${input.notes})
				RETURNING *`,
    );
    const row = rows[0];
    if (!row) throw new Error("INSERT RETURNING returned no rows");
    return row;
  }

  /** Update an existing life event, returning the updated row or null if not found. */
  async update(id: string, changes: UpdateLifeEventInput): Promise<LifeEventFullRow | null> {
    const setClauses: ReturnType<typeof sql>[] = [];
    if (changes.label !== undefined) setClauses.push(sql`label = ${changes.label}`);
    if (changes.startedAt !== undefined)
      setClauses.push(sql`started_at = ${changes.startedAt}::date`);
    if (changes.endedAt !== undefined)
      setClauses.push(
        changes.endedAt ? sql`ended_at = ${changes.endedAt}::date` : sql`ended_at = NULL`,
      );
    if (changes.category !== undefined)
      setClauses.push(
        changes.category ? sql`category = ${changes.category}` : sql`category = NULL`,
      );
    if (changes.ongoing !== undefined) setClauses.push(sql`ongoing = ${changes.ongoing}`);
    if (changes.notes !== undefined)
      setClauses.push(changes.notes ? sql`notes = ${changes.notes}` : sql`notes = NULL`);

    if (setClauses.length === 0) return null;

    const setExpr = sql.join(setClauses, sql`, `);
    const rows = await executeWithSchema(
      this.#db,
      lifeEventFullRowSchema,
      sql`UPDATE fitness.life_events SET ${setExpr} WHERE user_id = ${this.#userId} AND id = ${id} RETURNING *`,
    );
    return rows[0] ?? null;
  }

  /** Delete a life event by id. */
  async delete(id: string): Promise<{ success: boolean }> {
    await this.#db.execute(
      sql`DELETE FROM fitness.life_events WHERE user_id = ${this.#userId} AND id = ${id}`,
    );
    return { success: true };
  }

  /** Analyze a life event: compare metrics, sleep, and body composition before vs after. */
  async analyze(id: string, windowDays: number): Promise<AnalyzeResult | null> {
    const events = await executeWithSchema(
      this.#db,
      lifeEventLookupSchema,
      sql`SELECT * FROM fitness.life_events WHERE user_id = ${this.#userId} AND id = ${id}`,
    );
    if (!events[0]) return null;
    const event = events[0];

    const startDate = event.started_at;
    const endDate = event.ended_at ?? (event.ongoing ? "NOW()" : null);

    const beforeClause = sql`user_id = ${this.#userId} AND date BETWEEN (${startDate}::date - ${windowDays}::int) AND (${startDate}::date - 1)`;
    const afterClause = endDate
      ? sql`user_id = ${this.#userId} AND date BETWEEN ${startDate}::date AND ${endDate === "NOW()" ? sql`CURRENT_DATE` : sql`${endDate}::date`}`
      : sql`user_id = ${this.#userId} AND date BETWEEN ${startDate}::date AND (${startDate}::date + ${windowDays}::int)`;

    const metrics = await executeWithSchema(
      this.#db,
      metricsComparisonRowSchema,
      sql`
			WITH before_period AS (
				SELECT 'before' as period, *
				FROM fitness.v_daily_metrics
				WHERE ${beforeClause}
			),
			after_period AS (
				SELECT 'after' as period, *
				FROM fitness.v_daily_metrics
				WHERE ${afterClause}
			),
			combined AS (
				SELECT * FROM before_period
				UNION ALL
				SELECT * FROM after_period
			)
			SELECT
				period,
				COUNT(*) as days,
				AVG(resting_hr)::numeric(10,1) as avg_resting_hr,
				AVG(hrv)::numeric(10,1) as avg_hrv,
				AVG(steps)::numeric(10,0) as avg_steps,
				AVG(active_energy_kcal)::numeric(10,0) as avg_active_energy
			FROM combined
			GROUP BY period
			ORDER BY period
			`,
    );

    const [sleep, bodyComp] = await Promise.all([
      executeWithSchema(
        this.#db,
        sleepComparisonRowSchema,
        sql`
				WITH before_sleep AS (
					SELECT 'before' as period, *
					FROM fitness.v_sleep
					WHERE user_id = ${this.#userId}
						AND (started_at AT TIME ZONE ${this.#timezone})::date BETWEEN (${startDate}::date - ${windowDays}::int) AND (${startDate}::date - 1)
						AND NOT is_nap
				),
				after_sleep AS (
					SELECT 'after' as period, *
					FROM fitness.v_sleep
					WHERE user_id = ${this.#userId}
						AND ${
              endDate
                ? endDate === "NOW()"
                  ? sql`(started_at AT TIME ZONE ${this.#timezone})::date BETWEEN ${startDate}::date AND CURRENT_DATE`
                  : sql`(started_at AT TIME ZONE ${this.#timezone})::date BETWEEN ${startDate}::date AND ${endDate}::date`
                : sql`(started_at AT TIME ZONE ${this.#timezone})::date BETWEEN ${startDate}::date AND (${startDate}::date + ${windowDays}::int)`
            }
						AND NOT is_nap
				),
				combined AS (
					SELECT * FROM before_sleep
					UNION ALL
					SELECT * FROM after_sleep
				)
				SELECT
					period,
					COUNT(*) as nights,
					AVG(duration_minutes)::numeric(10,0) as avg_sleep_min,
					AVG(deep_minutes)::numeric(10,0) as avg_deep_min,
					AVG(rem_minutes)::numeric(10,0) as avg_rem_min,
					AVG(efficiency_pct)::numeric(10,1) as avg_efficiency
				FROM combined
				GROUP BY period
				ORDER BY period
				`,
      ),
      executeWithSchema(
        this.#db,
        bodyComparisonRowSchema,
        sql`
				WITH before_body AS (
					SELECT 'before' as period, *
					FROM fitness.v_body_measurement
					WHERE user_id = ${this.#userId}
						AND (recorded_at AT TIME ZONE ${this.#timezone})::date BETWEEN (${startDate}::date - ${windowDays}::int) AND (${startDate}::date - 1)
				),
				after_body AS (
					SELECT 'after' as period, *
					FROM fitness.v_body_measurement
					WHERE user_id = ${this.#userId}
						AND ${
              endDate
                ? endDate === "NOW()"
                  ? sql`(recorded_at AT TIME ZONE ${this.#timezone})::date BETWEEN ${startDate}::date AND CURRENT_DATE`
                  : sql`(recorded_at AT TIME ZONE ${this.#timezone})::date BETWEEN ${startDate}::date AND ${endDate}::date`
                : sql`(recorded_at AT TIME ZONE ${this.#timezone})::date BETWEEN ${startDate}::date AND (${startDate}::date + ${windowDays}::int)`
            }
				),
				combined AS (
					SELECT * FROM before_body
					UNION ALL
					SELECT * FROM after_body
				)
				SELECT
					period,
					COUNT(*) as measurements,
					AVG(weight_kg)::numeric(10,2) as avg_weight,
					AVG(body_fat_pct)::numeric(10,1) as avg_body_fat
				FROM combined
				GROUP BY period
				ORDER BY period
				`,
      ),
    ]);

    return { event, metrics, sleep, bodyComp };
  }
}
