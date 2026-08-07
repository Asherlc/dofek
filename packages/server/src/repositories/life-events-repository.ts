import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { fetchBodyComparisonRows } from "./body-clickhouse.ts";
import { fetchSleepNights } from "./clickhouse-sleep-repository.ts";
import { fetchRestingHeartRateValuesCte } from "./resting-heart-rate-query.ts";

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
  personal_experiment_id: z.string().nullable(),
  created_at: timestampStringSchema,
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
  personalExperimentId?: string | null;
}

export interface UpdateLifeEventInput {
  label?: string;
  startedAt?: string;
  endedAt?: string | null;
  category?: string | null;
  ongoing?: boolean;
  notes?: string | null;
  personalExperimentId?: string | null;
}

export class PersonalExperimentAssociationError extends Error {}

export interface AnalyzeResult {
  event: Record<string, unknown>;
  metrics: MetricsComparison[];
  sleep: SleepComparison[];
  bodyComp: BodyComparison[];
}

function averageNullable(values: (number | null)[]): number | null {
  const numericValues = values.filter((value): value is number => value != null);
  if (numericValues.length === 0) return null;
  return numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length;
}

function buildSleepComparisonRows(
  rows: {
    date: string;
    duration_minutes: number | null;
    deep_minutes: number | null;
    rem_minutes: number | null;
    efficiency_pct: number | null;
  }[],
  startDate: string,
  endDate: string,
  windowDays: number,
): SleepComparison[] {
  const beforeStartDate = addDays(startDate, -windowDays);
  const groups = [
    {
      period: "before",
      rows: rows.filter((row) => row.date >= beforeStartDate && row.date < startDate),
    },
    {
      period: "after",
      rows: rows.filter((row) => row.date >= startDate && row.date <= endDate),
    },
  ];
  return groups
    .filter((group) => group.rows.length > 0)
    .map((group) =>
      sleepComparisonRowSchema.parse({
        period: group.period,
        nights: group.rows.length,
        avg_sleep_min: averageNullable(group.rows.map((row) => row.duration_minutes)),
        avg_deep_min: averageNullable(group.rows.map((row) => row.deep_minutes)),
        avg_rem_min: averageNullable(group.rows.map((row) => row.rem_minutes)),
        avg_efficiency: averageNullable(group.rows.map((row) => row.efficiency_pct)),
      }),
    );
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for life events and before/after analysis. */
export class LifeEventsRepository {
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

  /** List all life events for the user, ordered by start date descending. */
  async list(): Promise<LifeEventRow[]> {
    return executeWithSchema(
      this.#db,
      lifeEventRowSchema,
      sql`SELECT id, label, started_at, ended_at, category, ongoing, notes, personal_experiment_id, created_at
				FROM fitness.life_events
				WHERE user_id = ${this.#userId}
				ORDER BY started_at DESC`,
    );
  }

  /** Create a new life event, returning the full row. */
  async create(input: CreateLifeEventInput): Promise<LifeEventFullRow> {
    const personalExperimentId = input.personalExperimentId ?? null;
    await this.#assertPersonalExperimentOwned(personalExperimentId);
    const rows = await executeWithSchema(
      this.#db,
      lifeEventFullRowSchema,
      sql`INSERT INTO fitness.life_events (
            user_id, label, started_at, ended_at, category, ongoing, notes, personal_experiment_id
          ) VALUES (
            ${this.#userId}, ${input.label}, ${input.startedAt}::date, ${input.endedAt}::date,
            ${input.category}, ${input.ongoing}, ${input.notes}, ${personalExperimentId}
          )
				RETURNING *`,
    );
    const row = rows[0];
    if (!row) throw new Error("INSERT RETURNING returned no rows");
    return row;
  }

  /** Update an existing life event, returning the updated row or null if not found. */
  async update(id: string, changes: UpdateLifeEventInput): Promise<LifeEventFullRow | null> {
    if (changes.personalExperimentId !== undefined) {
      await this.#assertPersonalExperimentOwned(changes.personalExperimentId);
    }
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
    if (changes.personalExperimentId !== undefined)
      setClauses.push(sql`personal_experiment_id = ${changes.personalExperimentId}`);

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

    const afterEndDate = endDate === "NOW()" ? sql`CURRENT_DATE` : sql`${endDate}::date`;
    const metricsEndDate = endDate ? afterEndDate : sql`(${startDate}::date + ${windowDays}::int)`;
    const metricsEndDateString =
      endDate === "NOW()"
        ? new Date().toISOString().slice(0, 10)
        : (endDate ?? addDays(startDate, windowDays));
    const restingHeartRateDays = daysBetween(addDays(startDate, -windowDays), metricsEndDateString);
    const restingHeartRateCte = await fetchRestingHeartRateValuesCte({
      sensorStore: this.#requireSensorStore(),
      userId: this.#userId,
      timezone: this.#timezone,
      endDate: metricsEndDateString,
      days: restingHeartRateDays,
    });

    const metrics = await executeWithSchema(
      this.#db,
      metricsComparisonRowSchema,
      sql`
			WITH ${restingHeartRateCte},
      before_dates AS (
				SELECT dm.date
				FROM fitness.v_daily_metrics dm
				WHERE dm.user_id = ${this.#userId}
				  AND dm.date BETWEEN (${startDate}::date - ${windowDays}::int) AND (${startDate}::date - 1)
				UNION
				SELECT drhr.date
				FROM resting_heart_rate drhr
				WHERE drhr.date BETWEEN (${startDate}::date - ${windowDays}::int) AND (${startDate}::date - 1)
			),
			after_dates AS (
				SELECT dm.date
				FROM fitness.v_daily_metrics dm
				WHERE dm.user_id = ${this.#userId}
				  AND dm.date BETWEEN ${startDate}::date AND ${metricsEndDate}
				UNION
				SELECT drhr.date
				FROM resting_heart_rate drhr
				WHERE drhr.date BETWEEN ${startDate}::date AND ${metricsEndDate}
			),
			before_period AS (
				SELECT 'before' as period, dm.hrv, dm.steps, drhr.resting_hr
				FROM before_dates dates
				LEFT JOIN fitness.v_daily_metrics dm
				  ON dm.user_id = ${this.#userId}
				 AND dm.date = dates.date
				LEFT JOIN resting_heart_rate drhr
				  ON drhr.date = dates.date
			),
			after_period AS (
				SELECT 'after' as period, dm.hrv, dm.steps, drhr.resting_hr
				FROM after_dates dates
				LEFT JOIN fitness.v_daily_metrics dm
				  ON dm.user_id = ${this.#userId}
				 AND dm.date = dates.date
				LEFT JOIN resting_heart_rate drhr
				  ON drhr.date = dates.date
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
				AVG(steps)::numeric(10,0) as avg_steps
			FROM combined
			GROUP BY period
			ORDER BY period
			`,
    );

    const [sleep, bodyComp] = await Promise.all([
      fetchSleepNights({
        sensorStore: this.#requireSensorStore(),
        userId: this.#userId,
        timezone: this.#timezone,
        endDate: metricsEndDateString,
        days: restingHeartRateDays,
        order: "asc",
      }).then((rows) =>
        buildSleepComparisonRows(rows, startDate, metricsEndDateString, windowDays),
      ),
      fetchBodyComparisonRows(
        this.#requireSensorStore(),
        this.#userId,
        this.#timezone,
        startDate,
        endDate,
        windowDays,
      ),
    ]);

    return { event, metrics, sleep, bodyComp };
  }

  #requireSensorStore(): Pick<ActivitySensorStore, "query"> {
    if (!this.#sensorStore) {
      throw new Error("ClickHouse activity analytics store is required for life event analysis");
    }
    return this.#sensorStore;
  }

  async #assertPersonalExperimentOwned(
    personalExperimentId: string | null | undefined,
  ): Promise<void> {
    if (personalExperimentId == null) return;
    const rows = await executeWithSchema(
      this.#db,
      z.object({ id: z.string() }),
      sql`SELECT id
          FROM fitness.personal_experiment
          WHERE id = ${personalExperimentId} AND user_id = ${this.#userId}`,
    );
    if (rows[0] === undefined) {
      throw new PersonalExperimentAssociationError(
        "Choose one of your own experiments to link this annotation.",
      );
    }
  }
}

function addDays(dateString: string, days: number): string {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(startDate: string, endDate: string): number {
  const startTime = new Date(`${startDate}T00:00:00.000Z`).getTime();
  const endTime = new Date(`${endDate}T00:00:00.000Z`).getTime();
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  return Math.max(1, Math.ceil((endTime - startTime) / millisecondsPerDay));
}
