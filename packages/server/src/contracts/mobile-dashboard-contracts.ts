import { activityDataStateSchema } from "@dofek/format/activity-data-state";
import { z } from "zod";
import {
  baselineComparisonDirectionSchema,
  baselineRelativeMetricSchema,
} from "./baseline-relative-metrics.ts";
import { epistemicStatusSchema } from "./epistemic-status-contract.ts";
import { progressiveOverloadRowSchema } from "./progressive-overload.ts";
import { trainingChartAvailabilitySchema } from "./training-chart-availability.ts";

const dateSchema = z.iso.date();
const score100Schema = z.number().min(0).max(100);
const strainScoreSchema = z.number().min(0).max(21);
const stressScoreSchema = z.number().min(0).max(3);
const nonnegativeNumberSchema = z.number().min(0);

export const workloadRatioResultSchema = z.object({
  context: z.object({
    label: z.string(),
    description: z.string(),
    recentDays: z.number().int().positive(),
    baselineDays: z.number().int().positive(),
  }),
  timeSeries: z.array(
    z.object({
      date: dateSchema,
      dailyLoad: nonnegativeNumberSchema,
      strain: strainScoreSchema,
      acuteLoad: nonnegativeNumberSchema,
      chronicLoad: nonnegativeNumberSchema,
      workloadRatio: nonnegativeNumberSchema.nullable(),
    }),
  ),
  displayedStrain: strainScoreSchema,
  displayedDate: dateSchema.nullable(),
});

export type WorkloadRatioResult = z.infer<typeof workloadRatioResultSchema>;

export const strainTargetResultSchema = z.object({
  targetStrain: strainScoreSchema,
  currentStrain: strainScoreSchema,
  currentStrainSource: z.enum(["activity", "none"]).optional(),
  currentPhysiologyLoad: nonnegativeNumberSchema.nullable().optional(),
  progressPercent: nonnegativeNumberSchema,
  zone: z.enum(["Push", "Maintain", "Recovery"]),
  explanation: z.string(),
  dailyLoad: nonnegativeNumberSchema.optional(),
  acuteLoad: nonnegativeNumberSchema.optional(),
  chronicLoad: nonnegativeNumberSchema.optional(),
  workloadRatio: nonnegativeNumberSchema.nullable().optional(),
  readinessScore: score100Schema.optional(),
});

const readinessComponentsOutputSchema = z.object({
  hrvScore: score100Schema,
  restingHrScore: score100Schema,
  sleepScore: score100Schema,
  respiratoryRateScore: score100Schema,
});

const readinessRowOutputSchema = z.object({
  date: dateSchema,
  readinessScore: score100Schema,
  components: readinessComponentsOutputSchema,
  weights: z.object({
    hrv: z.number().min(0).max(1),
    restingHr: z.number().min(0).max(1),
    sleep: z.number().min(0).max(1),
    respiratoryRate: z.number().min(0).max(1),
  }),
});

const stressOutputSchema = z.object({
  daily: z.array(
    z.object({
      date: dateSchema,
      stressScore: stressScoreSchema,
      hrvDeviation: z.number().nullable(),
      restingHrDeviation: z.number().nullable(),
      sleepEfficiency: z.number().min(0).max(100).nullable(),
    }),
  ),
  weekly: z.array(
    z.object({
      weekStart: dateSchema,
      cumulativeStress: nonnegativeNumberSchema,
      avgDailyStress: stressScoreSchema,
      highStressDays: z.number().int().nonnegative(),
    }),
  ),
  latestScore: stressScoreSchema.nullable(),
  trend: z.enum(["improving", "worsening", "stable"]),
});

const dailyMetricsOutputSchema = z.object({
  date: dateSchema,
  user_id: z.string().uuid(),
  hrv: nonnegativeNumberSchema.nullable(),
  spo2_avg: z.number().min(0).max(100).nullable(),
  respiratory_rate_avg: nonnegativeNumberSchema.nullable(),
  skin_temp_c: z.number().nullable(),
  steps: z.number().int().nonnegative().nullable(),
  distance_km: nonnegativeNumberSchema.nullable(),
  flights_climbed: z.number().int().nonnegative().nullable(),
  exercise_minutes: nonnegativeNumberSchema.nullable(),
  stand_hours: nonnegativeNumberSchema.nullable(),
  walking_speed: nonnegativeNumberSchema.nullable(),
  source_providers: z.array(z.string()),
});

export const healthMetricKeySchema = z.enum([
  "hrv",
  "resting_heart_rate",
  "respiratory_rate",
  "sleep_efficiency",
  "spo2",
  "steps",
  "skin_temperature",
  "trend_weight",
  "body_fat_percentage",
]);

export const healthMetricIntentSchema = z.enum(["higher", "lower", "maintain", "neutral"]);

export const HEALTH_METRIC_EVIDENCE_WINDOW_DAYS = 35;

export const healthMetricProvenanceSchema = z.object({
  latestDate: dateSchema.nullable(),
  sourceProviders: z.array(z.string()),
  observedDays: z.number().int().nonnegative(),
  windowDays: z.number().int().positive(),
});

export const healthMetricComparisonSchema = z.object({
  recentDays: z.number().int().positive(),
  baselineDays: z.number().int().positive(),
  recentMean: z.number().nullable(),
  baselineMean: z.number().nullable(),
  delta: z.number().nullable(),
  direction: baselineComparisonDirectionSchema,
});

export type HealthMetricProvenance = z.infer<typeof healthMetricProvenanceSchema>;
export type HealthMetricComparison = z.infer<typeof healthMetricComparisonSchema>;

export const baselineProgressBlockerSchema = z.enum([
  "missing_source_data",
  "collecting",
  "needs_variation",
  "syncing",
  "sync_error",
]);

export const baselineProgressSchema = z.object({
  requiredObservationDays: z.number().int().positive(),
  observedObservationDays: z.number().int().nonnegative(),
  hasMeasurableVariation: z.boolean(),
  blocker: baselineProgressBlockerSchema.nullable(),
  requirement: z.string(),
  summary: z.string(),
  action: z.string(),
});

export type BaselineProgress = z.infer<typeof baselineProgressSchema>;
export type BaselineProgressBlocker = z.infer<typeof baselineProgressBlockerSchema>;

export const healthStatusMetricSchema = z.object({
  metric: healthMetricKeySchema,
  label: z.string(),
  value: z.number().nullable(),
  valueText: z.string().nullable(),
  baseline: z.number().nullable(),
  baselineText: z.string().nullable(),
  sampleDeviation: z.number().nullable(),
  deviation: z.number().nullable(),
  direction: z.enum(["above", "below", "aligned", "unknown"]),
  intent: healthMetricIntentSchema,
  statusToken: z.enum([
    "insufficient_data",
    "near_baseline",
    "moving_as_intended",
    "notable_deviation",
    "far_from_baseline",
  ]),
  statusColor: z.enum(["positive", "warning", "danger", "muted"]),
  statusLabel: z.string(),
  evaluationRule: z.string(),
  explanation: z.string(),
  provenance: healthMetricProvenanceSchema.nullable(),
  comparison: healthMetricComparisonSchema.nullable(),
  baselineProgress: baselineProgressSchema,
});

export type HealthMetricKey = z.infer<typeof healthMetricKeySchema>;
export type HealthStatusMetric = z.infer<typeof healthStatusMetricSchema>;

export const mobileRecoveryTabOutputSchema = z.object({
  hrvVariability: z.array(
    z.object({
      date: dateSchema,
      hrv: nonnegativeNumberSchema.nullable(),
      rollingCoefficientOfVariation: nonnegativeNumberSchema.nullable(),
      rollingMean: nonnegativeNumberSchema.nullable(),
    }),
  ),
  hrvBaseline: z.array(
    z.object({
      date: dateSchema,
      hrv: nonnegativeNumberSchema.nullable(),
      resting_hr: nonnegativeNumberSchema.nullable(),
      mean_60d: nonnegativeNumberSchema.nullable(),
      sd_60d: nonnegativeNumberSchema.nullable(),
      mean_7d: nonnegativeNumberSchema.nullable(),
      resting_hr_mean_7d: nonnegativeNumberSchema.nullable(),
    }),
  ),
  readinessScore: z.array(readinessRowOutputSchema),
  stress: stressOutputSchema,
  trends: z
    .object({
      latest_spo2: z.number().min(0).max(100).nullable(),
      latest_skin_temp: z.number().nullable(),
    })
    .nullable(),
  dailyMetrics: z.array(dailyMetricsOutputSchema),
  weight: z.array(
    z.object({
      date: dateSchema,
      rawWeight: nonnegativeNumberSchema.nullable(),
      rawWeightStatus: epistemicStatusSchema.nullable(),
      smoothedWeight: nonnegativeNumberSchema,
      smoothedWeightStatus: epistemicStatusSchema,
      weeklyChange: z.number().nullable(),
      interpolated: z.boolean(),
    }),
  ),
  weightPrediction: z.object({
    ratePerWeek: z.number().nullable(),
    rateConfidence: z.number().min(0).max(1).nullable(),
    impliedDailyCalories: z.number().nullable(),
    periodDeltas: z.object({
      days7: z.number().nullable(),
      days14: z.number().nullable(),
      days30: z.number().nullable(),
    }),
    goal: z
      .object({
        goalWeightKg: nonnegativeNumberSchema,
        remainingKg: z.number(),
        estimatedDate: dateSchema.nullable(),
        daysRemaining: z.number().int().nullable(),
      })
      .nullable(),
    projectionLine: z.array(
      z.object({
        date: dateSchema,
        projectedWeight: nonnegativeNumberSchema,
      }),
    ),
  }),
  baselineRelative: z.array(baselineRelativeMetricSchema),
  healthStatus: z.array(healthStatusMetricSchema),
  healthspan: z.object({
    healthspanScore: score100Schema.nullable(),
    yearsDelta: z.number().nullable(),
    availability: z.object({
      status: z.enum(["available", "insufficient_data"]),
      availableMetricCount: z.number().int().min(0).max(9),
      requiredMetricCount: z.literal(3),
      missingMetricLabels: z.array(z.string()),
      summary: z.string(),
      nextCondition: z.string().nullable(),
    }),
    metrics: z.array(
      z.object({
        name: z.string(),
        value: z.number().nullable(),
        unit: z.string(),
        score: score100Schema,
        status: z.enum(["excellent", "good", "fair", "poor"]),
        yearsDelta: z.number(),
      }),
    ),
    history: z.array(
      z.object({
        weekStart: dateSchema,
        score: score100Schema,
      }),
    ),
    trend: z.enum(["improving", "declining", "stable"]).nullable(),
  }),
});

export type MobileRecoveryTabResult = z.infer<typeof mobileRecoveryTabOutputSchema>;

const activitySchema = z.object({
  id: z.string(),
  activity_type: z.string(),
  name: z.string().nullable(),
  started_at: z.iso.datetime(),
  ended_at: z.iso.datetime().nullable(),
  avg_hr: nonnegativeNumberSchema.nullable(),
  max_hr: nonnegativeNumberSchema.nullable(),
  avg_power: nonnegativeNumberSchema.nullable(),
  max_power: nonnegativeNumberSchema.nullable(),
  avg_cadence: nonnegativeNumberSchema.nullable(),
  hr_samples: z.number().int().nonnegative().nullable(),
  power_samples: z.number().int().nonnegative().nullable(),
  distance_meters: nonnegativeNumberSchema.nullable(),
  distance_state: activityDataStateSchema,
});

export const mobileTrainingTabOutputSchema = z.object({
  workloadRatio: workloadRatioResultSchema,
  strainTarget: strainTargetResultSchema.optional(),
  activities: z.array(activitySchema),
  weeklyVolume: z.array(
    z.object({
      week: dateSchema,
      activity_type: z.string(),
      count: z.number().int().nonnegative(),
      hours: nonnegativeNumberSchema,
    }),
  ),
  progressiveOverload: z.array(progressiveOverloadRowSchema),
  verticalAscent: z.array(
    z.object({
      date: dateSchema,
      activityName: z.string(),
      activityType: z.string(),
      verticalAscentRate: nonnegativeNumberSchema,
      elevationGainMeters: nonnegativeNumberSchema,
      elapsedMinutes: nonnegativeNumberSchema,
    }),
  ),
  chartAvailability: z.object({
    strainTrend: trainingChartAvailabilitySchema,
    verticalAscent: trainingChartAvailabilitySchema,
  }),
  climbing: z.object({
    gradeProgression: z.array(
      z.object({
        date: dateSchema,
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
        attempts: z.number().int().nonnegative(),
        sends: z.number().int().nonnegative(),
      }),
    ),
    sessionSummary: z.array(
      z.object({
        activityId: z.string(),
        date: dateSchema,
        name: z.string(),
        locationName: z.string().nullable(),
        attempts: z.number().int().nonnegative(),
        sends: z.number().int().nonnegative(),
        hardestBoulderGrade: z.string().nullable(),
        hardestBoulderGradeSortValue: z.number().nullable(),
        hardestRouteGrade: z.string().nullable(),
        hardestRouteGradeSortValue: z.number().nullable(),
      }),
    ),
  }),
});

export type MobileTrainingTabResult = z.infer<typeof mobileTrainingTabOutputSchema>;

const fixtureInputSchema = z.object({
  days: z.number().int().positive(),
  endDate: dateSchema,
});

interface FixtureWindow {
  days: number;
  endDate: string;
}

function fixtureWindowStart(input: FixtureWindow): string {
  const start = new Date(`${input.endDate}T12:00:00Z`);
  start.setUTCDate(start.getUTCDate() - (input.days - 1));
  return start.toISOString().slice(0, 10);
}

function validateDatesInWindow(
  input: FixtureWindow,
  dates: readonly string[],
  context: z.core.$RefinementCtx,
): void {
  const startDate = fixtureWindowStart(input);
  for (const date of dates) {
    if (date < startDate || date > input.endDate) {
      context.addIssue({
        code: "custom",
        message: `Fixture date ${date} is outside ${startDate}..${input.endDate}`,
      });
    }
  }
}

function validateWeeksOverlappingWindow(
  input: FixtureWindow,
  weekStarts: readonly string[],
  context: z.core.$RefinementCtx,
): void {
  const windowStart = fixtureWindowStart(input);
  for (const weekStart of weekStarts) {
    const weekStartDate = new Date(`${weekStart}T12:00:00Z`);
    if (weekStartDate.getUTCDay() !== 1) {
      context.addIssue({
        code: "custom",
        message: `Fixture week ${weekStart} must start on Monday`,
      });
      continue;
    }

    const weekEndDate = new Date(weekStartDate);
    weekEndDate.setUTCDate(weekEndDate.getUTCDate() + 6);
    const weekEnd = weekEndDate.toISOString().slice(0, 10);
    if (weekStart > input.endDate || weekEnd < windowStart) {
      context.addIssue({
        code: "custom",
        message: `Fixture week ${weekStart} does not overlap ${windowStart}..${input.endDate}`,
      });
    }
  }
}

function nearlyEqual(left: number | null | undefined, right: number | null | undefined): boolean {
  if (left == null || right == null) return left === right;
  return Math.abs(left - right) < 0.01;
}

export const workloadDisplayFixtureSchema = z
  .object({
    workloadRatio: workloadRatioResultSchema,
    strainTarget: strainTargetResultSchema.optional(),
  })
  .superRefine(({ workloadRatio, strainTarget }, context) => {
    const displayedRow =
      workloadRatio.displayedDate == null
        ? undefined
        : workloadRatio.timeSeries.find((row) => row.date === workloadRatio.displayedDate);
    if (
      workloadRatio.displayedDate != null &&
      (!displayedRow || !nearlyEqual(displayedRow.strain, workloadRatio.displayedStrain))
    ) {
      context.addIssue({
        code: "custom",
        path: ["workloadRatio", "displayedStrain"],
        message: "Displayed strain and date must identify a matching time-series point",
      });
    }

    if (strainTarget && displayedRow) {
      const targetChecks = [
        ["currentStrain", strainTarget.currentStrain, workloadRatio.displayedStrain],
        ["dailyLoad", strainTarget.dailyLoad, displayedRow.dailyLoad],
        ["acuteLoad", strainTarget.acuteLoad, displayedRow.acuteLoad],
        ["chronicLoad", strainTarget.chronicLoad, displayedRow.chronicLoad],
        ["workloadRatio", strainTarget.workloadRatio, displayedRow.workloadRatio],
      ] as const;
      for (const [field, targetValue, workloadValue] of targetChecks) {
        if (targetValue !== undefined && !nearlyEqual(targetValue, workloadValue)) {
          context.addIssue({
            code: "custom",
            path: ["strainTarget", field],
            message: `${field} must match the displayed workload point`,
          });
        }
      }
    }
  });

export const mobileRecoveryFixtureSchema = z
  .object({
    input: fixtureInputSchema,
    data: mobileRecoveryTabOutputSchema,
  })
  .superRefine(({ input, data }, context) => {
    validateDatesInWindow(
      input,
      [
        ...data.hrvVariability.map((row) => row.date),
        ...data.hrvBaseline.map((row) => row.date),
        ...data.readinessScore.map((row) => row.date),
        ...data.stress.daily.map((row) => row.date),
        ...data.dailyMetrics.map((row) => row.date),
        ...data.weight.map((row) => row.date),
      ],
      context,
    );
    validateWeeksOverlappingWindow(
      input,
      [
        ...data.stress.weekly.map((row) => row.weekStart),
        ...data.healthspan.history.map((row) => row.weekStart),
      ],
      context,
    );

    const latestStress = data.stress.daily.at(-1)?.stressScore ?? null;
    if (!nearlyEqual(data.stress.latestScore, latestStress)) {
      context.addIssue({
        code: "custom",
        path: ["data", "stress", "latestScore"],
        message: "Latest stress must match the final daily stress point",
      });
    }

    for (const [index, readiness] of data.readinessScore.entries()) {
      const weightTotal = Object.values(readiness.weights).reduce((sum, weight) => sum + weight, 0);
      if (!nearlyEqual(weightTotal, 1)) {
        context.addIssue({
          code: "custom",
          path: ["data", "readinessScore", index, "weights"],
          message: "Readiness weights must total 1",
        });
      }
    }
  });

export const mobileTrainingFixtureSchema = z
  .object({
    input: fixtureInputSchema,
    data: mobileTrainingTabOutputSchema.extend({
      // Historical fixture snapshots predate server-authored chart availability.
      // Runtime mobile dashboard responses remain strict via mobileTrainingTabOutputSchema.
      chartAvailability: mobileTrainingTabOutputSchema.shape.chartAvailability.optional(),
    }),
  })
  .superRefine(({ input, data }, context) => {
    validateDatesInWindow(
      input,
      [
        ...data.workloadRatio.timeSeries.map((row) => row.date),
        ...data.activities.map((row) => row.started_at.slice(0, 10)),
        ...data.verticalAscent.map((row) => row.date),
        ...data.climbing.gradeProgression.map((row) => row.date),
        ...data.climbing.sessionSummary.map((row) => row.date),
      ],
      context,
    );
    validateWeeksOverlappingWindow(
      input,
      data.weeklyVolume.map((row) => row.week),
      context,
    );

    const hasPositiveTrainingClaim =
      data.workloadRatio.displayedStrain > 0 ||
      (data.strainTarget?.currentStrain ?? 0) > 0 ||
      data.activities.length > 0 ||
      data.weeklyVolume.some((row) => row.count > 0 || row.hours > 0);
    if (hasPositiveTrainingClaim && data.workloadRatio.timeSeries.length < 2) {
      context.addIssue({
        code: "custom",
        path: ["data", "workloadRatio", "timeSeries"],
        message: "Positive training claims require enough trend points to avoid a no-data chart",
      });
    }

    const displayedRow =
      data.workloadRatio.displayedDate == null
        ? undefined
        : data.workloadRatio.timeSeries.find(
            (row) => row.date === data.workloadRatio.displayedDate,
          );
    if (
      data.workloadRatio.displayedDate != null &&
      (!displayedRow || !nearlyEqual(displayedRow.strain, data.workloadRatio.displayedStrain))
    ) {
      context.addIssue({
        code: "custom",
        path: ["data", "workloadRatio", "displayedStrain"],
        message: "Displayed strain and date must identify a matching time-series point",
      });
    }

    const target = data.strainTarget;
    if (target && data.workloadRatio.displayedDate === input.endDate) {
      const targetChecks = [
        ["currentStrain", target.currentStrain, data.workloadRatio.displayedStrain],
        ["dailyLoad", target.dailyLoad, displayedRow?.dailyLoad],
        ["acuteLoad", target.acuteLoad, displayedRow?.acuteLoad],
        ["chronicLoad", target.chronicLoad, displayedRow?.chronicLoad],
        ["workloadRatio", target.workloadRatio, displayedRow?.workloadRatio],
      ] as const;
      for (const [field, targetValue, workloadValue] of targetChecks) {
        if (!nearlyEqual(targetValue, workloadValue)) {
          context.addIssue({
            code: "custom",
            path: ["data", "strainTarget", field],
            message: `${field} must match the displayed workload point`,
          });
        }
      }
    }

    const activityCounts = new Map<string, number>();
    const activityHours = new Map<string, number>();
    for (const activity of data.activities) {
      activityCounts.set(
        activity.activity_type,
        (activityCounts.get(activity.activity_type) ?? 0) + 1,
      );
      if (activity.ended_at != null) {
        const hours =
          (new Date(activity.ended_at).getTime() - new Date(activity.started_at).getTime()) /
          3_600_000;
        activityHours.set(
          activity.activity_type,
          (activityHours.get(activity.activity_type) ?? 0) + hours,
        );
      }
    }

    const weeklyCounts = new Map<string, number>();
    const weeklyHours = new Map<string, number>();
    for (const row of data.weeklyVolume) {
      weeklyCounts.set(row.activity_type, (weeklyCounts.get(row.activity_type) ?? 0) + row.count);
      weeklyHours.set(row.activity_type, (weeklyHours.get(row.activity_type) ?? 0) + row.hours);
    }

    const activityTypes = new Set([...activityCounts.keys(), ...weeklyCounts.keys()]);
    for (const activityType of activityTypes) {
      if ((activityCounts.get(activityType) ?? 0) !== (weeklyCounts.get(activityType) ?? 0)) {
        context.addIssue({
          code: "custom",
          path: ["data", "weeklyVolume"],
          message: `Weekly ${activityType} count must match the fixture activities`,
        });
      }
      if (!nearlyEqual(activityHours.get(activityType) ?? 0, weeklyHours.get(activityType) ?? 0)) {
        context.addIssue({
          code: "custom",
          path: ["data", "weeklyVolume"],
          message: `Weekly ${activityType} hours must match the fixture activity durations`,
        });
      }
    }
  });
