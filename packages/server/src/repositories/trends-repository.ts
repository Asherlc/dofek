import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Round a numeric value to `decimals` places, returning null if the value is null. */
export function roundOrNull(value: unknown, decimals: number): number | null {
  if (value == null) return null;
  const factor = 10 ** decimals;
  return Math.round(Number(value) * factor) / factor;
}

// ---------------------------------------------------------------------------
// Domain model
// ---------------------------------------------------------------------------

interface TrendRowData {
  period: string;
  avgHr: number | null;
  maxHr: number | null;
  avgPower: number | null;
  maxPower: number | null;
  avgCadence: number | null;
  avgSpeed: number | null;
  totalSamples: number;
  hrSamples: number;
  powerSamples: number;
  activityCount: number;
}

/** A single trend row (daily or weekly) with rounding applied on serialization. */
export class TrendRow {
  readonly #row: TrendRowData;

  constructor(row: TrendRowData) {
    this.#row = row;
  }

  get period(): string {
    return this.#row.period;
  }

  get avgHr(): number | null {
    return this.#row.avgHr;
  }

  get activityCount(): number {
    return this.#row.activityCount;
  }

  toDetail() {
    return {
      avgHr: roundOrNull(this.#row.avgHr, 1),
      maxHr: this.#row.maxHr != null ? Number(this.#row.maxHr) : null,
      avgPower: roundOrNull(this.#row.avgPower, 1),
      maxPower: this.#row.maxPower != null ? Number(this.#row.maxPower) : null,
      avgCadence: roundOrNull(this.#row.avgCadence, 1),
      avgSpeed: roundOrNull(this.#row.avgSpeed, 2),
      totalSamples: Number(this.#row.totalSamples),
      hrSamples: Number(this.#row.hrSamples),
      powerSamples: Number(this.#row.powerSamples),
      activityCount: Number(this.#row.activityCount),
    };
  }
}

// ---------------------------------------------------------------------------
// Zod schema for raw DB rows
// ---------------------------------------------------------------------------

const trendDbSchema = z.object({
  period: dateStringSchema,
  avg_hr: z.coerce.number().nullable(),
  max_hr: z.coerce.number().nullable(),
  avg_power: z.coerce.number().nullable(),
  max_power: z.coerce.number().nullable(),
  avg_cadence: z.coerce.number().nullable(),
  avg_speed: z.coerce.number().nullable(),
  total_samples: z.coerce.number(),
  hr_samples: z.coerce.number(),
  power_samples: z.coerce.number(),
  activity_count: z.coerce.number(),
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

function mapRow(row: z.infer<typeof trendDbSchema>): TrendRow {
  return new TrendRow({
    period: row.period,
    avgHr: row.avg_hr,
    maxHr: row.max_hr,
    avgPower: row.avg_power,
    maxPower: row.max_power,
    avgCadence: row.avg_cadence,
    avgSpeed: row.avg_speed,
    totalSamples: row.total_samples,
    hrSamples: row.hr_samples,
    powerSamples: row.power_samples,
    activityCount: row.activity_count,
  });
}

/** Data access for daily and weekly activity trend aggregates. */
export class TrendsRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;

  constructor(db: Pick<Database, "execute">, userId: string) {
    this.#db = db;
    this.#userId = userId;
  }

  /** Daily activity metrics from the continuous aggregate. */
  async getDaily(days: number): Promise<TrendRow[]> {
    const rows = await executeWithSchema(
      this.#db,
      trendDbSchema,
      sql`SELECT
            bucket::date::text AS period,
            avg_hr,
            max_hr,
            avg_power,
            max_power,
            avg_cadence,
            avg_speed,
            total_samples,
            hr_samples,
            power_samples,
            activity_count
          FROM fitness.cagg_metric_daily
          WHERE user_id = ${this.#userId}
            AND bucket > NOW() - ${days}::int * INTERVAL '1 day'
          ORDER BY bucket ASC`,
    );

    return rows.map(mapRow);
  }

  /** Weekly activity metrics from the hierarchical continuous aggregate. */
  async getWeekly(weeks: number): Promise<TrendRow[]> {
    const days = weeks * 7;
    const rows = await executeWithSchema(
      this.#db,
      trendDbSchema,
      sql`SELECT
            bucket::date::text AS period,
            avg_hr,
            max_hr,
            avg_power,
            max_power,
            avg_cadence,
            avg_speed,
            total_samples,
            hr_samples,
            power_samples,
            activity_count
          FROM fitness.cagg_metric_weekly
          WHERE user_id = ${this.#userId}
            AND bucket > NOW() - ${days}::int * INTERVAL '1 day'
          ORDER BY bucket ASC`,
    );

    return rows.map(mapRow);
  }
}
