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
import {
  buildStrainTargetResult,
  clickHouseDateAccessWindowClause,
  clickHouseDateAccessWindowParams,
  loadStrainTargetInputs,
} from "./strain-target-result.ts";

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
  const accessParams = clickHouseDateAccessWindowParams(ctx.accessWindow);

  const [storedParams, strainTargetInputs, sleepRows] = await Promise.all([
    loadPersonalizedParams(ctx.db, ctx.userId),
    loadStrainTargetInputs({
      sensorStore,
      userId: ctx.userId,
      endDate,
      days,
      accessWindow: ctx.accessWindow,
    }),
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
        ${clickHouseDateAccessWindowClause(ctx.accessWindow, "sleep")}
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
  const readinessMetrics = strainTargetInputs.readinessMetrics;
  const strainTarget = buildStrainTargetResult({
    endDate,
    readinessMetrics,
    loads: strainTargetInputs.loads,
    readinessWeights: effective.readinessWeights,
  });

  const sleepRow = sleepRows[0];
  let sleepPerformance: ReturnType<typeof computeSleepPerformance> | null = null;
  let sleepDate: string | null = null;

  if (sleepRow?.duration_minutes != null && sleepRow.efficiency_pct != null) {
    sleepPerformance = computeSleepPerformance(
      sleepRow.duration_minutes,
      DEFAULT_SLEEP_NEED_MINUTES,
      sleepRow.efficiency_pct,
    );
    sleepDate = sleepRow.date;
  }

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
    sleepDate,
  });
}
