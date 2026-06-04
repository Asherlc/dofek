import {
  aggregateWeeklyStress,
  computeDailyStress,
  computeStressTrend,
  type WeeklyStressRow,
} from "@dofek/recovery/stress";
import { getEffectiveParams } from "dofek/personalization/params";
import { loadPersonalizedParams } from "dofek/personalization/storage";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import { BaseRepository } from "../lib/base-repository.ts";
import { dateWindowStartString } from "../lib/date-window.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";

export type { WeeklyStressRow };

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface DailyStressRow {
  date: string;
  stressScore: number;
  hrvDeviation: number | null;
  restingHrDeviation: number | null;
  sleepEfficiency: number | null;
}

export interface StressResult {
  daily: DailyStressRow[];
  weekly: WeeklyStressRow[];
  latestScore: number | null;
  trend: "improving" | "worsening" | "stable";
}

// ---------------------------------------------------------------------------
// Zod schema for raw DB rows
// ---------------------------------------------------------------------------

const rawRowSchema = z.object({
  date: dateStringSchema,
  hrv: z.coerce.number().nullable(),
  resting_hr: z.coerce.number().nullable(),
  hrv_mean_60d: z.coerce.number().nullable(),
  hrv_sd_60d: z.coerce.number().nullable(),
  rhr_mean_60d: z.coerce.number().nullable(),
  rhr_sd_60d: z.coerce.number().nullable(),
  efficiency_pct: z.coerce.number().nullable(),
});

type RawRow = z.infer<typeof rawRowSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeHrvDeviation(row: RawRow): number | null {
  if (
    row.hrv == null ||
    row.hrv_mean_60d == null ||
    row.hrv_sd_60d == null ||
    Number(row.hrv_sd_60d) <= 0
  ) {
    return null;
  }
  return (
    Math.round(((Number(row.hrv) - Number(row.hrv_mean_60d)) / Number(row.hrv_sd_60d)) * 100) / 100
  );
}

function computeRestingHrDeviation(row: RawRow): number | null {
  if (
    row.resting_hr == null ||
    row.rhr_mean_60d == null ||
    row.rhr_sd_60d == null ||
    Number(row.rhr_sd_60d) <= 0
  ) {
    return null;
  }
  return (
    Math.round(
      ((Number(row.resting_hr) - Number(row.rhr_mean_60d)) / Number(row.rhr_sd_60d)) * 100,
    ) / 100
  );
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access and stress computation for daily/weekly physiological stress. */
export class StressRepository extends BaseRepository {
  readonly #sensorStore?: Pick<ActivitySensorStore, "query">;

  constructor(
    db: Pick<import("dofek/db").Database, "execute">,
    userId: string,
    timezone = "UTC",
    sensorStore?: Pick<ActivitySensorStore, "query">,
    accessWindow?: AccessWindow,
  ) {
    super(db, userId, timezone, accessWindow);
    this.#sensorStore = sensorStore;
  }

  async getStressScores(days: number, endDate: string): Promise<StressResult> {
    const sensorStore = this.#requireSensorStore();
    const accessWindowClause =
      this.accessWindow.kind === "full"
        ? ""
        : `
          AND date >= toDate({accessStartDate:String})
          AND date < toDate({accessEndDateExclusive:String})`;
    const rows = await sensorStore.query(
      rawRowSchema,
      `SELECT
        toString(date) AS date,
        hrv,
        resting_hr,
        hrv_mean_60d,
        hrv_sd_60d,
        rhr_mean_60d,
        rhr_sd_60d,
        efficiency_pct
      FROM analytics.daily_recovery_inputs
      WHERE user_id = {userId:UUID}
        AND date > toDate({windowStart:String})
        AND date <= toDate({endDate:String})
        ${accessWindowClause}
      ORDER BY date ASC`,
      {
        userId: this.userId,
        windowStart: dateWindowStartString(endDate, days),
        endDate,
        ...(this.accessWindow.kind === "full"
          ? {}
          : {
              accessStartDate: this.accessWindow.startDate,
              accessEndDateExclusive: this.accessWindow.endDateExclusive,
            }),
      },
    );

    const storedParams = await loadPersonalizedParams(this.db, this.userId);
    const effective = getEffectiveParams(storedParams);

    const daily: DailyStressRow[] = rows.map((row) => {
      const hrvDeviation = computeHrvDeviation(row);
      const restingHrDeviation = computeRestingHrDeviation(row);
      const sleepEfficiency = row.efficiency_pct != null ? Number(row.efficiency_pct) : null;

      const { stressScore } = computeDailyStress(
        { hrvDeviation, restingHrDeviation, sleepEfficiency },
        effective.stressThresholds,
      );

      return {
        date: row.date,
        stressScore,
        hrvDeviation,
        restingHrDeviation,
        sleepEfficiency: sleepEfficiency != null ? Math.round(sleepEfficiency * 10) / 10 : null,
      };
    });

    const weekly = aggregateWeeklyStress(daily);
    const latestScore = daily.length > 0 ? (daily[daily.length - 1]?.stressScore ?? null) : null;
    const trend = computeStressTrend(daily);

    return { daily, weekly, latestScore, trend };
  }

  #requireSensorStore(): Pick<ActivitySensorStore, "query"> {
    if (!this.#sensorStore) {
      throw new Error("ClickHouse activity analytics store is required for stress scores");
    }
    return this.#sensorStore;
  }
}
