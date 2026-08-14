import {
  type ReadinessComponents,
  ReadinessScore,
  type ReadinessWeights,
} from "@dofek/recovery/readiness";
import { computeStrainTarget } from "@dofek/scoring/strain-target";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import { strainTargetResultSchema } from "../contracts/mobile-dashboard-contracts.ts";
import { computeCurrentStrain } from "../lib/current-strain.ts";
import { dateWindowStartString } from "../lib/date-window.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";

export { strainTargetResultSchema };

export type StrainTargetResult = z.infer<typeof strainTargetResultSchema>;

export const strainTargetReadinessRowSchema = z.object({
  date: dateStringSchema,
  hrv_score: z.coerce.number().nullable(),
  resting_hr_score: z.coerce.number().nullable(),
  sleep_score: z.coerce.number().nullable(),
  respiratory_rate_score: z.coerce.number().nullable(),
});

export type StrainTargetReadinessRow = z.infer<typeof strainTargetReadinessRowSchema>;

export const strainTargetLoadRowSchema = z.object({
  date: dateStringSchema,
  daily_load: z.coerce.number(),
});

export type StrainTargetLoadRow = z.infer<typeof strainTargetLoadRowSchema>;

export interface BuildStrainTargetResultInput {
  endDate: string;
  readinessMetrics: StrainTargetReadinessRow | undefined;
  loads: StrainTargetLoadRow[];
  readinessWeights: ReadinessWeights;
}

export interface LoadStrainTargetInputsArgs {
  sensorStore: ActivitySensorStore;
  userId: string;
  endDate: string;
  days?: number;
  accessWindow?: AccessWindow;
}

/**
 * Shared ClickHouse date access-window clause for analytics read models.
 */
export function clickHouseDateAccessWindowClause(
  accessWindow: AccessWindow | undefined,
  alias: string,
): string {
  return accessWindow?.kind === "limited"
    ? `AND ${alias}.date >= toDate({accessStartDate:String})
       AND ${alias}.date < toDate({accessEndDateExclusive:String})`
    : "";
}

/**
 * Shared ClickHouse date access-window query params for analytics read models.
 */
export function clickHouseDateAccessWindowParams(
  accessWindow: AccessWindow | undefined,
): Record<string, string> {
  return accessWindow?.kind === "limited"
    ? {
        accessStartDate: accessWindow.startDate,
        accessEndDateExclusive: accessWindow.endDateExclusive,
      }
    : {};
}

/**
 * Load the latest readiness row and daily strain loads used by strain-target assembly.
 */
export async function loadStrainTargetInputs(args: LoadStrainTargetInputsArgs): Promise<{
  readinessMetrics: StrainTargetReadinessRow | undefined;
  loads: StrainTargetLoadRow[];
}> {
  const days = args.days ?? 30;
  const windowStart = dateWindowStartString(args.endDate, days);
  const accessParams = clickHouseDateAccessWindowParams(args.accessWindow);

  const [readinessRows, loads] = await Promise.all([
    args.sensorStore.query(
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
        ${clickHouseDateAccessWindowClause(args.accessWindow, "recovery")}
      ORDER BY recovery.date DESC
      LIMIT 1`,
      {
        userId: args.userId,
        windowStart,
        endDate: args.endDate,
        ...accessParams,
      },
      { priority: "dashboard" },
    ),
    args.sensorStore.query(
      strainTargetLoadRowSchema,
      `SELECT
        toString(strain.date) AS date,
        strain.daily_load AS daily_load
      FROM analytics.daily_strain AS strain FINAL
      WHERE strain.user_id = {userId:UUID}
        AND strain.is_deleted = 0
        AND strain.date >= toDate({windowStart:String})
        AND strain.date <= toDate({endDate:String})
        ${clickHouseDateAccessWindowClause(args.accessWindow, "strain")}
      ORDER BY date ASC`,
      {
        userId: args.userId,
        windowStart,
        endDate: args.endDate,
        ...accessParams,
      },
      { priority: "dashboard" },
    ),
  ]);

  return {
    readinessMetrics: readinessRows[0],
    loads,
  };
}

/**
 * Assemble the API strain-target payload from readiness metrics and daily loads.
 * Shared by recovery.strainTarget and the mobile training tab.
 */
export function buildStrainTargetResult(
  input: BuildStrainTargetResultInput,
): StrainTargetResult | null {
  if (!input.readinessMetrics) return null;

  const components: ReadinessComponents = {
    hrvScore: Math.round(input.readinessMetrics.hrv_score ?? 62),
    restingHrScore: Math.round(input.readinessMetrics.resting_hr_score ?? 62),
    sleepScore: Math.round(input.readinessMetrics.sleep_score ?? 62),
    respiratoryRateScore: Math.round(input.readinessMetrics.respiratory_rate_score ?? 62),
  };
  const readinessScore = new ReadinessScore(components, input.readinessWeights).score;

  const acuteWindow = 7;
  const chronicWindow = 28;
  let acuteLoadTotal = 0;
  let chronicLoad = 0;
  const endTime = new Date(`${input.endDate}T00:00:00Z`).getTime();

  for (const row of input.loads) {
    const daysAgo = Math.floor((endTime - new Date(`${row.date}T00:00:00Z`).getTime()) / 86400000);
    if (daysAgo >= 0 && daysAgo < acuteWindow) acuteLoadTotal += row.daily_load;
    if (daysAgo >= 0 && daysAgo < chronicWindow) chronicLoad += row.daily_load;
  }
  const acuteLoad = acuteLoadTotal / acuteWindow;
  chronicLoad /= chronicWindow;

  const target = computeStrainTarget(readinessScore);
  const todayLoadRow = input.loads.find((row) => row.date === input.endDate);
  const todayLoad = todayLoadRow?.daily_load ?? 0;
  const currentStrain = computeCurrentStrain({ fallbackActivityLoad: todayLoad });
  const roundedCurrentStrain = Math.round(currentStrain.currentStrain * 10) / 10;
  const roundedAcuteLoad = Math.round(acuteLoad * 10) / 10;
  const roundedChronicLoad = Math.round(chronicLoad * 10) / 10;
  const workloadRatio = chronicLoad > 0 ? acuteLoad / chronicLoad : null;

  return {
    targetStrain: target.targetStrain,
    currentStrain: roundedCurrentStrain,
    currentStrainSource: currentStrain.currentStrainSource,
    currentPhysiologyLoad: currentStrain.currentPhysiologyLoad,
    progressPercent:
      target.targetStrain > 0 ? Math.round((roundedCurrentStrain / target.targetStrain) * 100) : 0,
    zone: target.zone,
    explanation: target.explanation,
    dailyLoad: Math.round(todayLoad * 10) / 10,
    acuteLoad: roundedAcuteLoad,
    chronicLoad: roundedChronicLoad,
    workloadRatio: workloadRatio != null ? Math.round(workloadRatio * 100) / 100 : null,
    readinessScore,
  };
}
