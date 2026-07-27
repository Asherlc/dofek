import { computeSleepPerformance } from "@dofek/scoring/sleep-performance";
import { buildTodayPlan, type TodayPlanResult } from "@dofek/scoring/today-plan";
import { TRPCError } from "@trpc/server";
import type { Database } from "dofek/db";
import { getEffectiveParams } from "dofek/personalization/params";
import { loadPersonalizedParams } from "dofek/personalization/storage";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import { dateWindowStartString } from "../lib/date-window.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { buildStrainTargetResult, strainTargetReadinessRowSchema } from "./strain-target-result.ts";

const DEFAULT_SLEEP_NEED_MINUTES = 480;

export interface TodayPlanContext {
  db: Pick<Database, "execute">;
  userId: string;
  accessWindow?: AccessWindow;
  sensorStore: ActivitySensorStore | undefined;
}

const sleepRowSchema = z.object({
  date: dateStringSchema,
  duration_minutes: z.coerce.number().nullable(),
  efficiency_pct: z.coerce.number().nullable(),
});

const strainLoadRowSchema = z.object({
  date: dateStringSchema,
  daily_load: z.coerce.number(),
});

function requireSensorStore(sensorStore: ActivitySensorStore | undefined): ActivitySensorStore {
  if (!sensorStore) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "todayPlan.get requires the ClickHouse activity analytics store. Set CLICKHOUSE_URL and retry.",
    });
  }
  return sensorStore;
}

function accessWindowClause(accessWindow: AccessWindow | undefined, alias: string): string {
  return accessWindow?.kind === "limited"
    ? `AND ${alias}.date >= toDate({accessStartDate:String})
       AND ${alias}.date < toDate({accessEndDateExclusive:String})`
    : "";
}

function accessWindowParams(accessWindow: AccessWindow | undefined): Record<string, string> {
  return accessWindow?.kind === "limited"
    ? {
        accessStartDate: accessWindow.startDate,
        accessEndDateExclusive: accessWindow.endDateExclusive,
      }
    : {};
}

/**
 * Load recovery, strain, and sleep inputs and return a deterministic Today Plan.
 */
export async function loadTodayPlan(
  ctx: TodayPlanContext,
  endDate: string,
  days = 30,
): Promise<TodayPlanResult> {
  const sensorStore = requireSensorStore(ctx.sensorStore);
  const windowStart = dateWindowStartString(endDate, days);
  const accessParams = accessWindowParams(ctx.accessWindow);

  const [storedParams, readinessRows, loadRows, sleepRows] = await Promise.all([
    loadPersonalizedParams(ctx.db, ctx.userId),
    sensorStore.query(
      strainTargetReadinessRowSchema,
      `SELECT
        toString(recovery.date) AS date,
        recovery.hrv_score AS hrv_score,
        recovery.resting_hr_score AS resting_hr_score,
        recovery.sleep_score AS sleep_score,
        recovery.respiratory_rate_score AS respiratory_rate_score
      FROM analytics.daily_recovery AS recovery FINAL
      WHERE recovery.user_id = {userId:UUID}
        AND recovery.is_deleted = 0
        AND recovery.date > toDate({windowStart:String})
        AND recovery.date <= toDate({endDate:String})
        ${accessWindowClause(ctx.accessWindow, "recovery")}
      ORDER BY recovery.date DESC
      LIMIT 1`,
      {
        userId: ctx.userId,
        windowStart,
        endDate,
        ...accessParams,
      },
      { priority: "dashboard" },
    ),
    sensorStore.query(
      strainLoadRowSchema,
      `SELECT
        toString(strain.date) AS date,
        strain.daily_load AS daily_load
      FROM analytics.daily_strain AS strain FINAL
      WHERE strain.user_id = {userId:UUID}
        AND strain.is_deleted = 0
        AND strain.date >= toDate({windowStart:String})
        AND strain.date <= toDate({endDate:String})
        ${accessWindowClause(ctx.accessWindow, "strain")}
      ORDER BY date ASC`,
      {
        userId: ctx.userId,
        windowStart,
        endDate,
        ...accessParams,
      },
      { priority: "dashboard" },
    ),
    sensorStore.query(
      sleepRowSchema,
      `SELECT
        toString(sleep.date) AS date,
        sleep.duration_minutes AS duration_minutes,
        sleep.efficiency_pct AS efficiency_pct
      FROM analytics.daily_sleep AS sleep FINAL
      WHERE sleep.user_id = {userId:UUID}
        AND sleep.is_deleted = 0
        AND sleep.date > toDate({windowStart:String})
        AND sleep.date <= toDate({endDate:String})
        ${accessWindowClause(ctx.accessWindow, "sleep")}
      ORDER BY sleep.date DESC
      LIMIT 1`,
      {
        userId: ctx.userId,
        windowStart,
        endDate,
        ...accessParams,
      },
      { priority: "dashboard" },
    ),
  ]);

  const effective = getEffectiveParams(storedParams);
  const readinessMetrics = readinessRows[0];
  const strainTarget = buildStrainTargetResult({
    endDate,
    readinessMetrics,
    loads: loadRows,
    readinessWeights: effective.readinessWeights,
  });

  const sleepRow = sleepRows[0];
  const sleepPerformance =
    sleepRow?.duration_minutes != null && sleepRow.efficiency_pct != null
      ? computeSleepPerformance(
          sleepRow.duration_minutes,
          DEFAULT_SLEEP_NEED_MINUTES,
          sleepRow.efficiency_pct,
        )
      : null;

  return buildTodayPlan({
    endDate,
    strainTarget:
      strainTarget == null
        ? null
        : {
            targetStrain: strainTarget.targetStrain,
            zone: strainTarget.zone,
            explanation: strainTarget.explanation,
            readinessScore: strainTarget.readinessScore ?? 0,
            workloadRatio: strainTarget.workloadRatio ?? null,
          },
    sleepPerformanceScore: sleepPerformance?.score ?? null,
    sleepPerformanceTier: sleepPerformance?.tier ?? null,
    recoveryDate: readinessMetrics?.date ?? null,
    sleepDate: sleepPerformance != null ? (sleepRow?.date ?? null) : null,
  });
}
