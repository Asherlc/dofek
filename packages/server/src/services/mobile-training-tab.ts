import { StrainScore } from "@dofek/scoring/scoring";
import type { Database } from "dofek/db";
import { getEffectiveParams } from "dofek/personalization/params";
import { loadPersonalizedParams } from "dofek/personalization/storage";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import { ChartRange } from "../lib/chart-range.ts";
import { dateWindowStartString } from "../lib/date-window.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import {
  type ClimbingGradeProgressionRow,
  ClimbingRepository,
  type ClimbingSessionSummaryRow,
  type ClimbingVolumeByGradeRow,
} from "../repositories/climbing-repository.ts";
import { CyclingAnalyticsRepository } from "../repositories/cycling-analytics-repository.ts";
import {
  type ActivityStatsRow,
  TrainingRepository,
  type WeeklyVolumeRow,
} from "../repositories/training-repository.ts";
import type { VerticalAscentRow } from "../routers/cycling-advanced.ts";
import {
  buildStrainTargetResult,
  clickHouseDateAccessWindowClause,
  clickHouseDateAccessWindowParams,
  type StrainTargetResult,
  strainTargetReadinessRowSchema,
} from "./strain-target-result.ts";
import {
  buildWorkloadRatioResult,
  type WorkloadRatioResult,
  workloadRatioResultSchema,
} from "./workload-ratio.ts";

export interface MobileTrainingTabResult {
  workloadRatio: WorkloadRatioResult;
  strainTarget?: StrainTargetResult;
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
  return buildWorkloadRatioResult(timeSeries);
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
  const cyclingRepo = new CyclingAnalyticsRepository(
    ctx.db,
    ctx.userId,
    ctx.timezone,
    ctx.sensorStore,
    ctx.accessWindow,
  );
  const climbingRepo = new ClimbingRepository(ctx.db, ctx.userId, ctx.timezone, ctx.accessWindow);

  const windowStart = dateWindowStartString(endDate, days);
  const accessParams = clickHouseDateAccessWindowParams(ctx.accessWindow);

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
        AND strain.is_deleted = 0
        AND strain.date > toDate({outputWindowStart:String})
        AND strain.date <= toDate({endDate:String})
        ${clickHouseDateAccessWindowClause(ctx.accessWindow, "strain")}
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
        AND recovery.is_deleted = 0
        AND recovery.date > toDate({windowStart:String})
        AND recovery.date <= toDate({endDate:String})
        ${clickHouseDateAccessWindowClause(ctx.accessWindow, "recovery")}
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
  ]);

  const effective = getEffectiveParams(storedParams);
  const workloadRatio = computeWorkloadRatio(strainRows);
  const strainTarget =
    buildStrainTargetResult({
      endDate,
      readinessMetrics: readinessRows[0],
      loads: strainRows.map((row) => ({ date: row.date, daily_load: row.daily_load })),
      readinessWeights: effective.readinessWeights,
    }) ?? undefined;

  const [
    { activities, weeklyVolume },
    cyclingAnalytics,
    gradeProgressionModels,
    volumeByGradeModels,
    sessionSummaryModels,
  ] = await Promise.all([
    trainingRepo.getActivityStatsAndWeeklyVolume(days),
    cyclingRepo.getActivities(ChartRange.fromDays(days), {
      activityLimit: 1,
      activityOffset: 0,
      variabilityLimit: 1,
      variabilityOffset: 0,
    }),
    climbingRepo.getGradeProgression(days),
    climbingRepo.getVolumeByGrade(days),
    climbingRepo.getSessionSummaries(days),
  ]);

  return {
    workloadRatio,
    strainTarget,
    activities,
    weeklyVolume,
    verticalAscent: cyclingAnalytics.verticalAscent,
    climbing: {
      gradeProgression: gradeProgressionModels.map((model) => model.toDetail()),
      volumeByGrade: volumeByGradeModels.map((model) => model.toDetail()),
      sessionSummary: sessionSummaryModels.map((model) => model.toDetail()),
    },
  };
}

export const mobileTrainingTabOutputSchema = z.object({
  workloadRatio: workloadRatioResultSchema,
  strainTarget: z
    .object({
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
    })
    .optional(),
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
      activityType: z.string(),
      verticalAscentRate: z.number(),
      elevationGainMeters: z.number(),
      elapsedMinutes: z.number(),
    }),
  ),
  climbing: z.object({
    gradeProgression: z.array(
      z.object({
        date: z.string(),
        climbType: z.enum(["boulder", "route"]),
        gradeSystem: z.enum(["v_scale", "yds"]),
        grade: z.string(),
        gradeSortValue: z.number(),
      }),
    ),
    volumeByGrade: z.array(
      z.object({
        climbType: z.enum(["boulder", "route"]),
        gradeSystem: z.enum(["v_scale", "yds"]),
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
