import {
  type ReadinessComponents,
  ReadinessScore,
  type ReadinessWeights,
} from "@dofek/recovery/readiness";
import { computeStrainTarget } from "@dofek/scoring/strain-target";
import { z } from "zod";
import { computeCurrentStrain } from "../lib/current-strain.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";

export const strainTargetResultSchema = z.object({
  targetStrain: z.number(),
  currentStrain: z.number(),
  currentStrainSource: z.enum(["activity", "none"]).optional(),
  currentPhysiologyLoad: z.number().nullable().optional(),
  progressPercent: z.number(),
  zone: z.enum(["Push", "Maintain", "Recovery"]),
  explanation: z.string(),
  dailyLoad: z.number().optional(),
  acuteLoad: z.number().optional(),
  chronicLoad: z.number().optional(),
  workloadRatio: z.number().nullable().optional(),
  readinessScore: z.number().optional(),
});

export type StrainTargetResult = z.infer<typeof strainTargetResultSchema>;

export const strainTargetReadinessRowSchema = z.object({
  date: dateStringSchema,
  hrv_score: z.coerce.number().nullable(),
  resting_hr_score: z.coerce.number().nullable(),
  sleep_score: z.coerce.number().nullable(),
  respiratory_rate_score: z.coerce.number().nullable(),
});

export type StrainTargetReadinessRow = z.infer<typeof strainTargetReadinessRowSchema>;

export interface StrainTargetLoadRow {
  date: string;
  daily_load: number;
}

export interface BuildStrainTargetResultInput {
  endDate: string;
  readinessMetrics: StrainTargetReadinessRow | undefined;
  loads: StrainTargetLoadRow[];
  readinessWeights: ReadinessWeights;
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
    if (daysAgo < acuteWindow) acuteLoadTotal += row.daily_load;
    if (daysAgo < chronicWindow) chronicLoad += row.daily_load;
  }
  const acuteLoad = acuteLoadTotal / acuteWindow;
  chronicLoad /= chronicWindow;

  const target = computeStrainTarget(readinessScore, chronicLoad, acuteLoad);
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
