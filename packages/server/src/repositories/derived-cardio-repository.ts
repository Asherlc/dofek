import { averageVo2MaxEstimates, isValidVo2MaxEstimate } from "@dofek/training/derived-cardio";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";

const dailyRestingHeartRateRowSchema = z.object({
  date: dateStringSchema,
  resting_hr: z.coerce.number(),
});

export interface DerivedCardioContext {
  userId: string;
  timezone: string;
}

export interface DerivedVo2MaxAverage {
  value: number;
  sampleCount: number;
}

export interface DailyRestingHeartRate {
  date: string;
  restingHr: number;
}

export class DerivedCardioRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #ctx: DerivedCardioContext;
  readonly #sensorStore?: ActivitySensorStore;

  constructor(
    db: Pick<Database, "execute">,
    ctx: DerivedCardioContext,
    sensorStore?: ActivitySensorStore,
  ) {
    this.#db = db;
    this.#ctx = ctx;
    this.#sensorStore = sensorStore;
  }

  async getVo2MaxAverage(endDate: string, days: number): Promise<DerivedVo2MaxAverage | null> {
    if (!this.#sensorStore) {
      throw new Error("VO2 max estimates require an activity sensor store");
    }

    const rows = await this.#sensorStore.getVo2MaxEstimates(
      endDate,
      days,
      this.#ctx.userId,
      this.#ctx.timezone,
    );
    const estimates = rows.map((row) => row.vo2max);
    const value = averageVo2MaxEstimates(estimates);
    const sampleCount = estimates.filter(isValidVo2MaxEstimate).length;
    return value === null ? null : { value, sampleCount };
  }

  async getDailyRestingHeartRates(endDate: string, days: number): Promise<DailyRestingHeartRate[]> {
    const rows = await executeWithSchema(
      this.#db,
      dailyRestingHeartRateRowSchema,
      sql`SELECT date, resting_hr
          FROM fitness.derived_resting_heart_rate
          WHERE user_id = ${this.#ctx.userId}
            AND date > (${endDate}::date - ${days}::int)
            AND date <= ${endDate}::date
          ORDER BY date ASC`,
    );
    return rows.map((row) => ({ date: row.date, restingHr: row.resting_hr }));
  }

  async getAverageRestingHeartRate(endDate: string, days: number): Promise<number | null> {
    const rows = await this.getDailyRestingHeartRates(endDate, days);
    if (rows.length === 0) {
      return null;
    }
    return rows.reduce((sum, row) => sum + row.restingHr, 0) / rows.length;
  }
}
