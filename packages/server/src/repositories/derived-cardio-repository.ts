import { averageVo2MaxEstimates } from "@dofek/training/derived-cardio";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";

const vo2MaxEstimateRowSchema = z.object({
  vo2max: z.coerce.number(),
});

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

  constructor(db: Pick<Database, "execute">, ctx: DerivedCardioContext) {
    this.#db = db;
    this.#ctx = ctx;
  }

  async getVo2MaxAverage(endDate: string, days: number): Promise<DerivedVo2MaxAverage | null> {
    const rows = await executeWithSchema(
      this.#db,
      vo2MaxEstimateRowSchema,
      sql`SELECT vo2max FROM fitness.derived_vo2max_estimates
          WHERE user_id = ${this.#ctx.userId}
            AND activity_date > (${endDate}::date - ${days}::int)
            AND activity_date <= ${endDate}::date`,
    );
    const value = averageVo2MaxEstimates(rows.map((row) => row.vo2max));
    return value === null ? null : { value, sampleCount: rows.length };
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
