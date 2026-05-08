import { z } from "zod";
import { dateStringSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";

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
  readonly #userId: string;
  readonly #sensorStore: Pick<ActivitySensorStore, "query">;

  constructor(userId: string, sensorStore: Pick<ActivitySensorStore, "query">) {
    this.#userId = userId;
    this.#sensorStore = sensorStore;
  }

  /** Daily activity metrics from the ClickHouse trend read model. */
  async getDaily(days: number): Promise<TrendRow[]> {
    const rows = await this.#sensorStore.query(
      trendDbSchema,
      `
        SELECT
          toString(bucket_date) AS period,
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
        FROM analytics.activity_trend_daily
        WHERE user_id = {userId:UUID}
          AND bucket_date > today() - toIntervalDay({days:UInt32})
        ORDER BY bucket_date ASC
      `,
      { userId: this.#userId, days },
    );

    return rows.map(mapRow);
  }

  /** Weekly activity metrics rolled up from the ClickHouse daily trend read model. */
  async getWeekly(weeks: number): Promise<TrendRow[]> {
    const days = weeks * 7;
    const rows = await this.#sensorStore.query(
      trendDbSchema,
      `
        SELECT
          toString(week_start) AS period,
          CAST(hr_weighted_sum / nullIf(weekly_hr_samples, 0), 'Nullable(Float64)') AS avg_hr,
          max_hr,
          CAST(power_weighted_sum / nullIf(weekly_power_samples, 0), 'Nullable(Float64)') AS avg_power,
          max_power,
          CAST(cadence_weighted_sum / nullIf(weekly_cadence_samples, 0), 'Nullable(Float64)') AS avg_cadence,
          CAST(speed_weighted_sum / nullIf(weekly_speed_samples, 0), 'Nullable(Float64)') AS avg_speed,
          weekly_total_samples AS total_samples,
          weekly_hr_samples AS hr_samples,
          weekly_power_samples AS power_samples,
          weekly_activity_count AS activity_count
        FROM (
          SELECT
            toStartOfWeek(bucket_date, 1) AS week_start,
            sum(avg_hr * hr_samples) AS hr_weighted_sum,
            max(max_hr) AS max_hr,
            sum(avg_power * power_samples) AS power_weighted_sum,
            max(max_power) AS max_power,
            sum(avg_cadence * cadence_samples) AS cadence_weighted_sum,
            sum(avg_speed * speed_samples) AS speed_weighted_sum,
            sum(total_samples) AS weekly_total_samples,
            sum(hr_samples) AS weekly_hr_samples,
            sum(power_samples) AS weekly_power_samples,
            sum(cadence_samples) AS weekly_cadence_samples,
            sum(speed_samples) AS weekly_speed_samples,
            sum(activity_count) AS weekly_activity_count
          FROM analytics.activity_trend_daily
          WHERE user_id = {userId:UUID}
            AND bucket_date > today() - toIntervalDay({days:UInt32})
          GROUP BY week_start
        )
        ORDER BY week_start ASC
      `,
      { userId: this.#userId, days },
    );

    return rows.map(mapRow);
  }
}
