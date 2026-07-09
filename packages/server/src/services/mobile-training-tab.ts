import { type ReadinessComponents, ReadinessScore } from "@dofek/recovery/readiness";
import { StrainScore } from "@dofek/scoring/scoring";
import { computeStrainTarget } from "@dofek/scoring/strain-target";
import { selectRecentDailyLoad } from "@dofek/training/training";
import type { Database } from "dofek/db";
import { getEffectiveParams } from "dofek/personalization/params";
import { loadPersonalizedParams } from "dofek/personalization/storage";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import { computeCurrentStrain } from "../lib/current-strain.ts";
import { dateWindowStartString } from "../lib/date-window.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import {
  type ClimbingGradeProgressionRow,
  ClimbingRepository,
  type ClimbingSessionSummaryRow,
  type ClimbingVolumeByGradeRow,
} from "../repositories/climbing-repository.ts";
import { CyclingAdvancedRepository } from "../repositories/cycling-advanced-repository.ts";
import {
  type ActivityStatsRow,
  TrainingRepository,
  type WeeklyVolumeRow,
} from "../repositories/training-repository.ts";
import type { VerticalAscentRow } from "../routers/cycling-advanced.ts";
import type { StrainTargetResult, WorkloadRatioResult } from "../routers/recovery.ts";

export interface MobileTrainingTabResult {
  workloadRatio: WorkloadRatioResult;
  strainTarget: StrainTargetResult;
  activities: ActivityStatsRow[];
  weeklyVolume: WeeklyVolumeRow[];
  verticalAscent: VerticalAscentRow[];
  climbing: {
    gradeProgression: ClimbingGradeProgressionRow[];
    volumeByGrade: ClimbingVolumeByGradeRow[];
    sessionSummary: ClimbingSessionSummaryRow[];
  };
}

interface MobileTrainingTabContext {
  db: Pick<Database, "execute">;
  userId: string;
  timezone: string;
  accessWindow?: AccessWindow;
  sensorStore: ActivitySensorStore;
}

const strainRowSchema = z.object({
  date: z.string(),
  daily_load: z.coerce.number(),
  acute_load: z.coerce.number(),
  chronic_load: z.coerce.number(),
  workload_ratio: z.coerce.number().nullable(),
});

const strainTargetReadinessRowSchema = z.object({
  date: dateStringSchema,
  hrv_score: z.coerce.number().nullable(),
  resting_hr_score: z.coerce.number().nullable(),
  sleep_score: z.coerce.number().nullable(),
  respiratory_rate_score: z.coerce.number().nullable(),
});

function strainAccessClause(accessWindow?: AccessWindow): string {
  return accessWindow?.kind === "limited"
    ? `AND strain.date >= toDate({accessStartDate:String})
       AND strain.date < toDate({accessEndDateExclusive:String})`
    : "";
}

function strainAccessParams(accessWindow?: AccessWindow): Record<string, string> {
  return accessWindow?.kind === "limited"
    ? {
        accessStartDate: accessWindow.startDate,
        accessEndDateExclusive: accessWindow.endDateExclusive,
      }
    : {};
}

function recoveryAccessClause(accessWindow?: AccessWindow): string {
  return accessWindow?.kind === "limited"
    ? `AND recovery.date >= toDate({accessStartDate:String})
       AND recovery.date < toDate({accessEndDateExclusive:String})`
    : "";
}

function recoveryAccessParams(accessWindow?: AccessWindow): Record<string, string> {
  return accessWindow?.kind === "limited"
    ? {
        accessStartDate: accessWindow.startDate,
        accessEndDateExclusive: accessWindow.endDateExclusive,
      }
    : {};
}

function computeWorkloadRatio(rows: z.infer<typeof strainRowSchema>[]): WorkloadRatioResult {
  const timeSeries = rows.map((row) => {
    const dailyLoad = Math.round(Number(row.daily_load) * 10) / 10;
    const acuteLoad = Math.round(Number(row.acute_load) * 10) / 10;
    return {
      date: row.date,
      dailyLoad,
      strain: StrainScore.fromRawLoad(dailyLoad).value,
      acuteLoad,
      chronicLoad: Math.round(Number(row.chronic_load) * 10) / 10,
      workloadRatio:
        row.workload_ratio != null ? Math.round(Number(row.workload_ratio) * 100) / 100 : null,
    };
  });
  const displayed = selectRecentDailyLoad(timeSeries);
  return {
    timeSeries,
    displayedStrain: displayed?.strain ?? 0,
    displayedDate: displayed?.date ?? null,
  };
}

function computeStrainTargetFromLoads(
  loads: Array<{ date: string; daily_load: number }>,
  readinessMetrics: z.infer<typeof strainTargetReadinessRowSchema> | undefined,
  endDate: string,
  weights: ReturnType<typeof getEffectiveParams>["readinessWeights"],
): StrainTargetResult {
  let readinessScore = 50;
  if (readinessMetrics) {
    const components: ReadinessComponents = {
      hrvScore: Math.round(readinessMetrics.hrv_score ?? 62),
      restingHrScore: Math.round(readinessMetrics.resting_hr_score ?? 62),
      sleepScore: Math.round(readinessMetrics.sleep_score ?? 62),
      respiratoryRateScore: Math.round(readinessMetrics.respiratory_rate_score ?? 62),
    };
    readinessScore = new ReadinessScore(components, weights).score;
  }

  const acuteWindow = 7;
  const chronicWindow = 28;
  let acuteLoadTotal = 0;
  let chronicLoad = 0;

  for (const row of loads) {
    const daysAgo = Math.floor(
      (new Date(`${endDate}T00:00:00Z`).getTime() - new Date(`${row.date}T00:00:00Z`).getTime()) /
        86400000,
    );
    if (daysAgo < acuteWindow) acuteLoadTotal += row.daily_load;
    if (daysAgo < chronicWindow) chronicLoad += row.daily_load;
  }
  const acuteLoad = acuteLoadTotal / acuteWindow;
  chronicLoad /= chronicWindow;

  const target = computeStrainTarget(readinessScore, chronicLoad, acuteLoad);
  const todayLoadRow = loads.find((row) => row.date === endDate);
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

export async function loadMobileTrainingTab(
  ctx: MobileTrainingTabContext,
  days: number,
  endDate: string,
): Promise<MobileTrainingTabResult> {
  const trainingRepo = new TrainingRepository(
    ctx.db,
    ctx.userId,
    ctx.timezone,
    ctx.sensorStore,
    ctx.accessWindow,
  );
  const cyclingRepo = new CyclingAdvancedRepository(
    ctx.db,
    ctx.userId,
    ctx.timezone,
    ctx.sensorStore,
  );
  const climbingRepo = new ClimbingRepository(ctx.db, ctx.userId, ctx.timezone);

  const windowStart = dateWindowStartString(endDate, days);
  const accessParams = strainAccessParams(ctx.accessWindow);

  const [storedParams, strainRows, readinessRows] = await Promise.all([
    loadPersonalizedParams(ctx.db, ctx.userId),
    ctx.sensorStore.query(
      strainRowSchema,
      `SELECT
        toString(toDate(toTimeZone(toDateTime(strain.date), {timezone:String}))) AS date,
        strain.daily_load AS daily_load,
        strain.acute_load_7d AS acute_load,
        strain.chronic_load_28d AS chronic_load,
        strain.workload_ratio AS workload_ratio
      FROM analytics.daily_strain AS strain FINAL
      WHERE strain.user_id = {userId:UUID}
        AND strain.date > toDate({outputWindowStart:String})
        AND strain.date <= toDate({endDate:String})
        ${strainAccessClause(ctx.accessWindow)}
      ORDER BY date ASC`,
      {
        userId: ctx.userId,
        timezone: ctx.timezone,
        endDate,
        outputWindowStart: windowStart,
        ...accessParams,
      },
      { priority: "dashboard" },
    ),
    ctx.sensorStore.query(
      strainTargetReadinessRowSchema,
      `SELECT
        toString(recovery.date) AS date,
        recovery.hrv_score AS hrv_score,
        recovery.resting_hr_score AS resting_hr_score,
        recovery.sleep_score AS sleep_score,
        recovery.respiratory_rate_score AS respiratory_rate_score
      FROM analytics.daily_recovery AS recovery FINAL
      WHERE recovery.user_id = {userId:UUID}
        AND recovery.date > toDate({windowStart:String})
        AND recovery.date <= toDate({endDate:String})
        ${recoveryAccessClause(ctx.accessWindow)}
      ORDER BY recovery.date DESC
      LIMIT 1`,
      {
        userId: ctx.userId,
        windowStart,
        endDate,
        ...recoveryAccessParams(ctx.accessWindow),
      },
      { priority: "dashboard" },
    ),
  ]);

  const effective = getEffectiveParams(storedParams);
  const workloadRatio = computeWorkloadRatio(strainRows);
  const strainTarget = computeStrainTargetFromLoads(
    strainRows.map((row) => ({ date: row.date, daily_load: row.daily_load })),
    readinessRows[0],
    endDate,
    effective.readinessWeights,
  );

  const [
    { activities, weeklyVolume },
    verticalAscentModels,
    gradeProgressionModels,
    volumeByGradeModels,
    sessionSummaryModels,
  ] = await Promise.all([
    trainingRepo.getActivityStatsAndWeeklyVolume(days),
    cyclingRepo.getVerticalAscentRates(days),
    climbingRepo.getGradeProgression(days),
    climbingRepo.getVolumeByGrade(days),
    climbingRepo.getSessionSummaries(days),
  ]);

  return {
    workloadRatio,
    strainTarget,
    activities,
    weeklyVolume,
    verticalAscent: verticalAscentModels.map((model) => model.toDetail()),
    climbing: {
      gradeProgression: gradeProgressionModels.map((model) => model.toDetail()),
      volumeByGrade: volumeByGradeModels.map((model) => model.toDetail()),
      sessionSummary: sessionSummaryModels.map((model) => model.toDetail()),
    },
  };
}

export const mobileTrainingTabOutputSchema = z.object({
  workloadRatio: z.object({
    timeSeries: z.array(
      z.object({
        date: z.string(),
        dailyLoad: z.number(),
        strain: z.number(),
        acuteLoad: z.number(),
        chronicLoad: z.number(),
        workloadRatio: z.number().nullable(),
      }),
    ),
    displayedStrain: z.number(),
    displayedDate: z.string().nullable(),
  }),
  strainTarget: z.object({
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
  }),
  activities: z.array(
    z.object({
      id: z.string(),
      activity_type: z.string(),
      name: z.string().nullable(),
      started_at: z.string(),
      ended_at: z.string().nullable(),
      avg_hr: z.number().nullable(),
      max_hr: z.number().nullable(),
      avg_power: z.number().nullable(),
      max_power: z.number().nullable(),
      avg_cadence: z.number().nullable(),
      hr_samples: z.number().nullable(),
      power_samples: z.number().nullable(),
      distance_meters: z.number().nullable(),
    }),
  ),
  weeklyVolume: z.array(
    z.object({
      week: z.string(),
      activity_type: z.string(),
      count: z.number(),
      hours: z.number(),
    }),
  ),
  verticalAscent: z.array(
    z.object({
      date: z.string(),
      activityName: z.string(),
      verticalAscentRate: z.number(),
      elevationGainMeters: z.number(),
      climbingMinutes: z.number(),
    }),
  ),
  climbing: z.object({
    gradeProgression: z.array(
      z.object({
        date: z.string(),
        climbType: z.enum(["boulder", "route"]),
        gradeSystem: z.enum(["v_scale", "yds", "font", "french"]),
        grade: z.string(),
        gradeSortValue: z.number(),
      }),
    ),
    volumeByGrade: z.array(
      z.object({
        climbType: z.enum(["boulder", "route"]),
        gradeSystem: z.enum(["v_scale", "yds", "font", "french"]),
        grade: z.string(),
        gradeSortValue: z.number(),
        attempts: z.number(),
        sends: z.number(),
      }),
    ),
    sessionSummary: z.array(
      z.object({
        activityId: z.string(),
        date: z.string(),
        name: z.string(),
        locationName: z.string().nullable(),
        attempts: z.number(),
        sends: z.number(),
        hardestBoulderGrade: z.string().nullable(),
        hardestBoulderGradeSortValue: z.number().nullable(),
        hardestRouteGrade: z.string().nullable(),
        hardestRouteGradeSortValue: z.number().nullable(),
      }),
    ),
  }),
}) satisfies z.ZodType<MobileTrainingTabResult>;
