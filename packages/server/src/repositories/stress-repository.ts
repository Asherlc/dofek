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
import {
  clickHouseWindowStartPredicate,
  dateWindowStartStringOrUndefined,
  type RangeDays,
} from "../lib/date-window.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorQueryOptions, ActivitySensorStore } from "./activity-repository.ts";

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
  hrv_z_score: z.coerce.number().nullable(),
  resting_hr_z_score: z.coerce.number().nullable(),
  efficiency_pct: z.coerce.number().nullable(),
});

type RawRow = z.infer<typeof rawRowSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeHrvDeviation(row: RawRow): number | null {
  return row.hrv_z_score == null ? null : Math.round(row.hrv_z_score * 100) / 100;
}

function computeRestingHrDeviation(row: RawRow): number | null {
  return row.resting_hr_z_score == null ? null : Math.round(row.resting_hr_z_score * 100) / 100;
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

  async getStressScores(
    days: RangeDays,
    endDate: string,
    queryOptions?: ActivitySensorQueryOptions,
  ): Promise<StressResult> {
    const sensorStore = this.#requireSensorStore();
    const accessWindowClause =
      this.accessWindow.kind === "full"
        ? ""
        : `
          AND recovery_inputs.date >= toDate({accessStartDate:String})
          AND recovery_inputs.date < toDate({accessEndDateExclusive:String})`;
    const rows = await sensorStore.query(
      rawRowSchema,
      `SELECT
        toString(recovery_inputs.date) AS date,
        hrv_z_score,
        resting_hr_z_score,
        efficiency_pct
      FROM analytics.daily_recovery AS recovery_inputs FINAL
      WHERE recovery_inputs.user_id = {userId:UUID}
        AND recovery_inputs.is_deleted = 0
        ${clickHouseWindowStartPredicate({
          expression: "recovery_inputs.date",
          days,
        })}
        AND recovery_inputs.date <= toDate({endDate:String})
        ${accessWindowClause}
      ORDER BY recovery_inputs.date ASC`,
      {
        userId: this.userId,
        ...(dateWindowStartStringOrUndefined(endDate, days) !== undefined
          ? { windowStart: dateWindowStartStringOrUndefined(endDate, days) }
          : {}),
        endDate,
        ...(this.accessWindow.kind === "full"
          ? {}
          : {
              accessStartDate: this.accessWindow.startDate,
              accessEndDateExclusive: this.accessWindow.endDateExclusive,
            }),
      },
      queryOptions,
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
