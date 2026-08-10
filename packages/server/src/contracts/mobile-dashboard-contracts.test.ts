import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import type { MobileRecoveryTabResult as ServiceMobileRecoveryTabResult } from "../services/mobile-recovery-tab.ts";
import type { MobileTrainingTabResult as ServiceMobileTrainingTabResult } from "../services/mobile-training-tab.ts";
import type { WorkloadRatioResult as ServiceWorkloadRatioResult } from "../services/workload-ratio.ts";
import {
  type MobileRecoveryTabResult,
  type MobileTrainingTabResult,
  mobileRecoveryFixtureSchema,
  mobileRecoveryTabOutputSchema,
  mobileTrainingFixtureSchema,
  type WorkloadRatioResult,
  workloadDisplayFixtureSchema,
} from "./mobile-dashboard-contracts.ts";

const input = {
  days: 30,
  endDate: "2026-07-27",
};

function expectIssue<T>(
  result: z.ZodSafeParseResult<T>,
  path: PropertyKey[],
  message: string,
): void {
  if (result.success) throw new Error(`Expected fixture issue: ${message}`);
  expect(result.error.issues).toContainEqual(expect.objectContaining({ path, message }));
}

function first<T>(items: T[], label: string): T {
  const value = items[0];
  if (value === undefined) throw new Error(`Missing ${label} fixture`);
  return value;
}

function validRecoveryFixture(): z.input<typeof mobileRecoveryFixtureSchema> {
  return {
    input,
    data: {
      hrvVariability: [
        {
          date: "2026-07-26",
          hrv: 51,
          rollingCoefficientOfVariation: 0.12,
          rollingMean: 52,
        },
        {
          date: input.endDate,
          hrv: 53,
          rollingCoefficientOfVariation: 0.11,
          rollingMean: 52,
        },
      ],
      hrvBaseline: [
        {
          date: input.endDate,
          hrv: 53,
          resting_hr: 52,
          mean_60d: 50,
          sd_60d: 4,
          mean_7d: 52,
          resting_hr_mean_7d: 53,
        },
      ],
      readinessScore: [
        {
          date: input.endDate,
          readinessScore: 82,
          components: {
            hrvScore: 84,
            restingHrScore: 78,
            sleepScore: 88,
            respiratoryRateScore: 74,
          },
          weights: { hrv: 0.5, restingHr: 0.2, sleep: 0.15, respiratoryRate: 0.15 },
        },
      ],
      stress: {
        daily: [
          {
            date: "2026-07-26",
            stressScore: 1.2,
            hrvDeviation: null,
            restingHrDeviation: null,
            sleepEfficiency: 90,
          },
          {
            date: input.endDate,
            stressScore: 1.4,
            hrvDeviation: null,
            restingHrDeviation: null,
            sleepEfficiency: 88,
          },
        ],
        weekly: [],
        latestScore: 1.4,
        trend: "stable" as const,
      },
      trends: {
        latest_spo2: 97.2,
        latest_skin_temp: 33.8,
      },
      dailyMetrics: [
        {
          date: input.endDate,
          user_id: "00000000-0000-0000-0000-000000000000",
          hrv: 53,
          spo2_avg: 97.2,
          respiratory_rate_avg: 14.1,
          skin_temp_c: 33.8,
          steps: 8200,
          distance_km: 6.1,
          flights_climbed: 8,
          exercise_minutes: 70,
          stand_hours: 12,
          walking_speed: 1.3,
          source_providers: ["apple_health"],
        },
      ],
      weight: [
        {
          date: input.endDate,
          rawWeight: 73.5,
          rawWeightStatus: { kind: "observed", label: "Observed" },
          smoothedWeight: 73.6,
          smoothedWeightStatus: { kind: "estimated", label: "Estimated" },
          weeklyChange: -0.2,
          interpolated: false,
        },
      ],
      bodyFat: [{ date: "2026-03-20", bodyFatPct: 20.9 }],
      decisionContext: {
        latestMeasurement: {
          date: input.endDate,
          recordedAt: "2026-07-27T08:00:00.000Z",
          recordedAtLocal: "2026-07-27 08:00:00",
          weightKg: 73.5,
          providerId: "withings",
          sourceName: "Body+",
        },
        trendWeight: {
          smoothing: "ewma",
          alpha: 0.1,
          gapHandling: "linear_interpolation",
          invalidWeightHandling: "exclude_non_positive",
          outlierHandling: "retain",
        },
        variation: {
          status: "available",
          observations: 8,
          minimumObservations: 8,
          maximumObservations: 30,
          method: "tukey_inner_fence",
          lowerResidualKg: -0.4,
          upperResidualKg: 0.5,
          outliersIncluded: true,
        },
      },
      weightPrediction: {
        ratePerWeek: -0.2,
        rateConfidence: 0.72,
        impliedDailyCalories: -220,
        periodDeltas: { days7: -0.15, days14: -0.28, days30: -0.55 },
        goal: {
          goalWeightKg: 72.5,
          remainingKg: 1.1,
          estimatedDate: "2026-09-25",
          daysRemaining: 60,
        },
        projectionLine: [],
      },
      baselineRelative: [
        {
          metric: "hrv",
          label: "Heart Rate Variability (HRV)",
          value: 53,
          baseline: {
            windowDays: 30,
            mean: 50,
            standardDeviation: 4,
            zScore: 0.75,
            sampleCount: 28,
            coverage: 28 / 30,
          },
          comparison: {
            recentDays: 7,
            baselineDays: 28,
            recentMean: 52,
            baselineMean: 50,
            delta: 2,
            direction: "increasing",
          },
        },
      ],
      healthStatus: [],
      healthspan: {
        healthspanScore: 84,
        yearsDelta: 1.8,
        availability: {
          status: "available",
          availableMetricCount: 3,
          requiredMetricCount: 3,
          missingMetricLabels: [],
          summary: "3 of 3 required Healthspan metrics are available.",
          nextCondition: null,
        },
        metrics: [],
        history: [],
        trend: "improving" as const,
      },
    },
  };
}

function validTrainingFixture(): z.input<typeof mobileTrainingFixtureSchema> {
  return {
    input,
    data: {
      workloadRatio: {
        context: {
          label: "Recent-to-baseline workload ratio",
          description: "Descriptive training context.",
          recentDays: 7,
          baselineDays: 28,
        },
        displayedStrain: 12.5,
        displayedDate: input.endDate,
        timeSeries: [
          {
            date: "2026-07-26",
            dailyLoad: 390,
            strain: 11.8,
            acuteLoad: 370,
            chronicLoad: 400,
            workloadRatio: 0.93,
          },
          {
            date: input.endDate,
            dailyLoad: 450,
            strain: 12.5,
            acuteLoad: 380,
            chronicLoad: 400,
            workloadRatio: 0.95,
          },
        ],
      },
      strainTarget: {
        targetStrain: 13.5,
        currentStrain: 12.5,
        currentStrainSource: "activity" as const,
        currentPhysiologyLoad: 450,
        progressPercent: 93,
        zone: "Push" as const,
        explanation: "Recovery and training load support a productive training day.",
        dailyLoad: 450,
        acuteLoad: 380,
        chronicLoad: 400,
        workloadRatio: 0.95,
        readinessScore: 78,
      },
      activities: [
        {
          id: "a1",
          name: "Morning Ride",
          canonical_type: "cycling",
          started_at: "2026-07-27T07:00:00.000Z",
          ended_at: "2026-07-27T08:30:00.000Z",
          avg_hr: 148,
          max_hr: 176,
          avg_power: 235,
          max_power: 580,
          avg_cadence: 88,
          hr_samples: 5400,
          power_samples: 5400,
          distance_meters: 42000,
          distance_state: { status: "available" },
        },
        {
          id: "a2",
          name: "Evening Run",
          canonical_type: "running",
          started_at: "2026-07-26T18:00:00.000Z",
          ended_at: "2026-07-26T18:45:00.000Z",
          avg_hr: 155,
          max_hr: 172,
          avg_power: null,
          max_power: null,
          avg_cadence: null,
          hr_samples: 2700,
          power_samples: null,
          distance_meters: 7500,
          distance_state: { status: "available" },
        },
      ],
      weeklyVolume: [
        { week: "2026-07-27", canonical_type: "cycling", count: 1, hours: 1.5 },
        { week: "2026-07-20", canonical_type: "running", count: 1, hours: 0.75 },
      ],
      progressiveOverload: [],
      verticalAscent: [],
      climbing: {
        gradeProgression: [],
        volumeByGrade: [],
        sessionSummary: [],
      },
    },
  };
}

function validWorkloadDisplayFixture(): z.input<typeof workloadDisplayFixtureSchema> {
  const training = validTrainingFixture();
  if (training.data.strainTarget === undefined) throw new Error("Missing strain target fixture");
  return {
    workloadRatio: training.data.workloadRatio,
    strainTarget: training.data.strainTarget,
  };
}

function zeroClaimTrainingFixture(): z.input<typeof mobileTrainingFixtureSchema> {
  const fixture = validTrainingFixture();
  fixture.data.workloadRatio.timeSeries = [
    {
      date: input.endDate,
      dailyLoad: 0,
      strain: 0,
      acuteLoad: 0,
      chronicLoad: 0,
      workloadRatio: null,
    },
  ];
  fixture.data.workloadRatio.displayedStrain = 0;
  fixture.data.workloadRatio.displayedDate = input.endDate;
  delete fixture.data.strainTarget;
  fixture.data.activities = [];
  fixture.data.weeklyVolume = [];
  return fixture;
}

describe("mobileRecoveryFixtureSchema", () => {
  it("accepts a complete fixture that matches the runtime output contract", () => {
    expect(mobileRecoveryFixtureSchema.parse(validRecoveryFixture())).toBeTruthy();
  });

  it("parses bodyFat history", () => {
    const parsed = mobileRecoveryTabOutputSchema.parse(validRecoveryFixture().data);

    expect(parsed.bodyFat).toEqual([{ date: "2026-03-20", bodyFatPct: 20.9 }]);
  });

  it("rejects stress values outside the server-owned 0-3 range", () => {
    const fixture = validRecoveryFixture();
    const latestStress = fixture.data.stress.daily[1];
    if (!latestStress) throw new Error("Missing latest stress fixture");
    latestStress.stressScore = 34;

    expect(mobileRecoveryFixtureSchema.safeParse(fixture).success).toBe(false);
  });

  it("rejects a latest stress claim that contradicts the latest daily point", () => {
    const fixture = validRecoveryFixture();
    fixture.data.stress.latestScore = 2.8;

    expectIssue(
      mobileRecoveryFixtureSchema.safeParse(fixture),
      ["data", "stress", "latestScore"],
      "Latest stress must match the final daily stress point",
    );
  });

  it.each([
    [
      "HRV variability",
      (fixture: z.input<typeof mobileRecoveryFixtureSchema>) => {
        first(fixture.data.hrvVariability, "HRV variability").date = "2026-06-27";
      },
    ],
    [
      "HRV baseline",
      (fixture: z.input<typeof mobileRecoveryFixtureSchema>) => {
        first(fixture.data.hrvBaseline, "HRV baseline").date = "2026-06-27";
      },
    ],
    [
      "readiness",
      (fixture: z.input<typeof mobileRecoveryFixtureSchema>) => {
        first(fixture.data.readinessScore, "readiness").date = "2026-06-27";
      },
    ],
    [
      "daily stress",
      (fixture: z.input<typeof mobileRecoveryFixtureSchema>) => {
        first(fixture.data.stress.daily, "daily stress").date = "2026-06-27";
      },
    ],
    [
      "daily metrics",
      (fixture: z.input<typeof mobileRecoveryFixtureSchema>) => {
        first(fixture.data.dailyMetrics, "daily metrics").date = "2026-06-27";
      },
    ],
    [
      "weight",
      (fixture: z.input<typeof mobileRecoveryFixtureSchema>) => {
        first(fixture.data.weight, "weight").date = "2026-06-27";
      },
    ],
  ])("rejects an out-of-window %s row", (_label, moveOutsideWindow) => {
    const fixture = validRecoveryFixture();
    moveOutsideWindow(fixture);

    expectIssue(
      mobileRecoveryFixtureSchema.safeParse(fixture),
      [],
      "Fixture date 2026-06-27 is outside 2026-06-28..2026-07-27",
    );
  });

  it("accepts rows exactly on both selected-window boundaries", () => {
    const fixture = validRecoveryFixture();
    first(fixture.data.hrvVariability, "HRV variability").date = "2026-06-28";
    first(fixture.data.hrvBaseline, "HRV baseline").date = input.endDate;

    expect(mobileRecoveryFixtureSchema.safeParse(fixture).success).toBe(true);
  });

  it("rejects rows after the selected-window end", () => {
    const fixture = validRecoveryFixture();
    first(fixture.data.hrvVariability, "HRV variability").date = "2026-07-28";

    expectIssue(
      mobileRecoveryFixtureSchema.safeParse(fixture),
      [],
      "Fixture date 2026-07-28 is outside 2026-06-28..2026-07-27",
    );
  });

  it("rejects an out-of-window decision-context measurement date", () => {
    const fixture = validRecoveryFixture();
    const latestMeasurement = fixture.data.decisionContext?.latestMeasurement;
    if (!latestMeasurement) throw new Error("Missing decision-context measurement fixture");
    latestMeasurement.date = "2026-07-28";

    expectIssue(
      mobileRecoveryFixtureSchema.safeParse(fixture),
      [],
      "Fixture date 2026-07-28 is outside 2026-06-28..2026-07-27",
    );
  });

  it.each([
    [
      "a missing decision context",
      (fixture: z.input<typeof mobileRecoveryFixtureSchema>) => {
        fixture.data.decisionContext = null;
      },
    ],
    [
      "a missing latest measurement",
      (fixture: z.input<typeof mobileRecoveryFixtureSchema>) => {
        if (!fixture.data.decisionContext) throw new Error("Missing decision-context fixture");
        fixture.data.decisionContext.latestMeasurement = null;
      },
    ],
  ])("accepts recovery fixtures with %s", (_label, removeMeasurement) => {
    const fixture = validRecoveryFixture();
    removeMeasurement(fixture);

    expect(mobileRecoveryFixtureSchema.safeParse(fixture).success).toBe(true);
  });

  it("rejects calendar-invalid dates even when they sort inside the selected window", () => {
    const fixture = validRecoveryFixture();
    const firstHrv = fixture.data.hrvVariability[0];
    if (!firstHrv) throw new Error("Missing HRV fixture");
    firstHrv.date = "2026-06-31";

    expect(mobileRecoveryFixtureSchema.safeParse(fixture).success).toBe(false);
  });

  it("accepts a Monday-based week that overlaps the start of the selected window", () => {
    const fixture = validRecoveryFixture();
    fixture.data.stress.weekly.push({
      weekStart: "2026-06-22",
      cumulativeStress: 7,
      avgDailyStress: 1,
      highStressDays: 0,
    });

    expect(mobileRecoveryFixtureSchema.safeParse(fixture).success).toBe(true);
  });

  it("rejects Monday-based weeks entirely before or after the selected window", () => {
    const fixture = validRecoveryFixture();
    fixture.data.stress.weekly.push({
      weekStart: "2026-06-15",
      cumulativeStress: 7,
      avgDailyStress: 1,
      highStressDays: 0,
    });
    fixture.data.healthspan.history.push({ weekStart: "2026-08-03", score: 84 });

    const result = mobileRecoveryFixtureSchema.safeParse(fixture);
    expectIssue(result, [], "Fixture week 2026-06-15 does not overlap 2026-06-28..2026-07-27");
    expectIssue(result, [], "Fixture week 2026-08-03 does not overlap 2026-06-28..2026-07-27");
  });

  it("accepts an empty daily stress series when latest stress is null", () => {
    const fixture = validRecoveryFixture();
    fixture.data.stress.daily = [];
    fixture.data.stress.latestScore = null;

    expect(mobileRecoveryFixtureSchema.safeParse(fixture).success).toBe(true);
  });

  it("rejects either one-sided null latest-stress mismatch", () => {
    const missingLatest = validRecoveryFixture();
    missingLatest.data.stress.latestScore = null;
    expectIssue(
      mobileRecoveryFixtureSchema.safeParse(missingLatest),
      ["data", "stress", "latestScore"],
      "Latest stress must match the final daily stress point",
    );

    const missingDaily = validRecoveryFixture();
    missingDaily.data.stress.daily = [];
    missingDaily.data.stress.latestScore = 1.4;
    expectIssue(
      mobileRecoveryFixtureSchema.safeParse(missingDaily),
      ["data", "stress", "latestScore"],
      "Latest stress must match the final daily stress point",
    );
  });

  it("does not coerce null latest stress to a zero daily score", () => {
    const fixture = validRecoveryFixture();
    first(fixture.data.stress.daily.slice(-1), "latest stress").stressScore = 0;
    fixture.data.stress.latestScore = null;

    expectIssue(
      mobileRecoveryFixtureSchema.safeParse(fixture),
      ["data", "stress", "latestScore"],
      "Latest stress must match the final daily stress point",
    );
  });

  it("uses the final daily stress point rather than the second point", () => {
    const fixture = validRecoveryFixture();
    fixture.data.stress.daily.push({
      date: input.endDate,
      stressScore: 2,
      hrvDeviation: null,
      restingHrDeviation: null,
      sleepEfficiency: 86,
    });
    fixture.data.stress.latestScore = 2;

    expect(mobileRecoveryFixtureSchema.safeParse(fixture).success).toBe(true);
  });

  it("requires readiness weights to total one", () => {
    const fixture = validRecoveryFixture();
    first(fixture.data.readinessScore, "readiness").weights.hrv = 0.4;

    expectIssue(
      mobileRecoveryFixtureSchema.safeParse(fixture),
      ["data", "readinessScore", 0, "weights"],
      "Readiness weights must total 1",
    );
  });
});

describe("workloadDisplayFixtureSchema", () => {
  it("accepts coherent workload display and strain-target claims", () => {
    expect(workloadDisplayFixtureSchema.safeParse(validWorkloadDisplayFixture()).success).toBe(
      true,
    );
  });

  it("accepts a display with no selected date or strain target", () => {
    const fixture = validWorkloadDisplayFixture();
    fixture.workloadRatio.displayedDate = null;
    delete fixture.strainTarget;

    expect(workloadDisplayFixtureSchema.safeParse(fixture).success).toBe(true);
  });

  it("rejects a selected display date with no matching time-series row", () => {
    const fixture = validWorkloadDisplayFixture();
    fixture.workloadRatio.displayedDate = "2026-07-25";

    expectIssue(
      workloadDisplayFixtureSchema.safeParse(fixture),
      ["workloadRatio", "displayedStrain"],
      "Displayed strain and date must identify a matching time-series point",
    );
  });

  it("rejects a selected display strain that contradicts its time-series row", () => {
    const fixture = validWorkloadDisplayFixture();
    fixture.workloadRatio.displayedStrain = 8;

    expectIssue(
      workloadDisplayFixtureSchema.safeParse(fixture),
      ["workloadRatio", "displayedStrain"],
      "Displayed strain and date must identify a matching time-series point",
    );
  });

  it("checks every present strain-target field against the displayed workload point", () => {
    const fixture = validWorkloadDisplayFixture();
    const target = fixture.strainTarget;
    if (target === undefined) throw new Error("Missing strain target fixture");
    target.currentStrain = 8;
    target.dailyLoad = 1;
    target.acuteLoad = 2;
    target.chronicLoad = 3;
    target.workloadRatio = 0.4;

    const result = workloadDisplayFixtureSchema.safeParse(fixture);
    for (const field of [
      "currentStrain",
      "dailyLoad",
      "acuteLoad",
      "chronicLoad",
      "workloadRatio",
    ]) {
      expectIssue(
        result,
        ["strainTarget", field],
        `${field} must match the displayed workload point`,
      );
    }
  });

  it("allows omitted optional target fields and equal null workload ratios", () => {
    const fixture = validWorkloadDisplayFixture();
    const target = fixture.strainTarget;
    if (target === undefined) throw new Error("Missing strain target fixture");
    delete target.dailyLoad;
    const displayed = first(fixture.workloadRatio.timeSeries.slice(-1), "displayed workload");
    displayed.workloadRatio = null;
    target.workloadRatio = null;

    expect(workloadDisplayFixtureSchema.safeParse(fixture).success).toBe(true);
  });

  it("rejects a number-to-null target mismatch", () => {
    const fixture = validWorkloadDisplayFixture();
    const target = fixture.strainTarget;
    if (target === undefined) throw new Error("Missing strain target fixture");
    const displayed = first(fixture.workloadRatio.timeSeries.slice(-1), "displayed workload");
    displayed.workloadRatio = null;
    target.workloadRatio = 0;

    expectIssue(
      workloadDisplayFixtureSchema.safeParse(fixture),
      ["strainTarget", "workloadRatio"],
      "workloadRatio must match the displayed workload point",
    );
  });

  it("accepts numeric drift below one hundredth but rejects the boundary", () => {
    const withinTolerance = validWorkloadDisplayFixture();
    const withinRow = first(
      withinTolerance.workloadRatio.timeSeries.slice(-1),
      "displayed workload",
    );
    withinRow.strain = 0;
    withinTolerance.workloadRatio.displayedStrain = 0.009;
    const withinTarget = withinTolerance.strainTarget;
    if (withinTarget === undefined) throw new Error("Missing strain target fixture");
    withinTarget.currentStrain = 0.009;
    expect(workloadDisplayFixtureSchema.safeParse(withinTolerance).success).toBe(true);

    const atBoundary = validWorkloadDisplayFixture();
    const boundaryRow = first(atBoundary.workloadRatio.timeSeries.slice(-1), "displayed workload");
    boundaryRow.strain = 0;
    atBoundary.workloadRatio.displayedStrain = 0.01;
    const boundaryTarget = atBoundary.strainTarget;
    if (boundaryTarget === undefined) throw new Error("Missing strain target fixture");
    boundaryTarget.currentStrain = 0.01;
    expectIssue(
      workloadDisplayFixtureSchema.safeParse(atBoundary),
      ["workloadRatio", "displayedStrain"],
      "Displayed strain and date must identify a matching time-series point",
    );
  });
});

describe("mobileTrainingFixtureSchema", () => {
  it("accepts coherent training claims backed by runtime-valid data", () => {
    expect(mobileTrainingFixtureSchema.parse(validTrainingFixture())).toBeTruthy();
  });

  it("rejects a positive training story whose trend renders as no data", () => {
    const fixture = validTrainingFixture();
    fixture.data.workloadRatio.timeSeries = fixture.data.workloadRatio.timeSeries.slice(-1);

    expectIssue(
      mobileTrainingFixtureSchema.safeParse(fixture),
      ["data", "workloadRatio", "timeSeries"],
      "Positive training claims require enough trend points to avoid a no-data chart",
    );
  });

  it("accepts a one-point trend when every rendered training claim is zero or empty", () => {
    expect(mobileTrainingFixtureSchema.safeParse(zeroClaimTrainingFixture()).success).toBe(true);
  });

  it("does not treat a zero-valued weekly row as a positive training claim", () => {
    const fixture = zeroClaimTrainingFixture();
    fixture.data.weeklyVolume.push({
      week: "2026-07-27",
      canonical_type: "walking",
      count: 0,
      hours: 0,
    });

    expect(mobileTrainingFixtureSchema.safeParse(fixture).success).toBe(true);
  });

  it.each([
    [
      "displayed strain",
      (fixture: z.input<typeof mobileTrainingFixtureSchema>) => {
        fixture.data.workloadRatio.displayedStrain = 1;
        first(fixture.data.workloadRatio.timeSeries, "workload").strain = 1;
      },
    ],
    [
      "strain target",
      (fixture: z.input<typeof mobileTrainingFixtureSchema>) => {
        fixture.data.strainTarget = {
          targetStrain: 1,
          currentStrain: 1,
          progressPercent: 100,
          zone: "Maintain",
          explanation: "Target claim",
        };
      },
    ],
    [
      "activity card",
      (fixture: z.input<typeof mobileTrainingFixtureSchema>) => {
        fixture.data.activities.push({
          id: "positive-activity",
          name: "Short walk",
          canonical_type: "walking",
          started_at: "2026-07-27T07:00:00.000Z",
          ended_at: null,
          avg_hr: null,
          max_hr: null,
          avg_power: null,
          max_power: null,
          avg_cadence: null,
          hr_samples: null,
          power_samples: null,
          distance_meters: null,
          distance_state: { status: "missing", reason: "Distance not recorded" },
        });
      },
    ],
    [
      "weekly count",
      (fixture: z.input<typeof mobileTrainingFixtureSchema>) => {
        fixture.data.weeklyVolume.push({
          week: "2026-07-27",
          canonical_type: "walking",
          count: 1,
          hours: 0,
        });
      },
    ],
    [
      "weekly hours",
      (fixture: z.input<typeof mobileTrainingFixtureSchema>) => {
        fixture.data.weeklyVolume.push({
          week: "2026-07-27",
          canonical_type: "walking",
          count: 0,
          hours: 1,
        });
      },
    ],
  ])("requires two trend points for a positive %s claim", (_label, addPositiveClaim) => {
    const fixture = zeroClaimTrainingFixture();
    addPositiveClaim(fixture);

    expectIssue(
      mobileTrainingFixtureSchema.safeParse(fixture),
      ["data", "workloadRatio", "timeSeries"],
      "Positive training claims require enough trend points to avoid a no-data chart",
    );
  });

  it("rejects strain-target values that contradict the displayed workload point", () => {
    const fixture = validTrainingFixture();
    const target = fixture.data.strainTarget;
    if (target === undefined) throw new Error("Missing strain target fixture");
    target.currentStrain = 8.4;

    expectIssue(
      mobileTrainingFixtureSchema.safeParse(fixture),
      ["data", "strainTarget", "currentStrain"],
      "currentStrain must match the displayed workload point",
    );
  });

  it("checks every current-day strain-target field", () => {
    const fixture = validTrainingFixture();
    const target = fixture.data.strainTarget;
    if (target === undefined) throw new Error("Missing strain target fixture");
    target.currentStrain = 8;
    target.dailyLoad = 1;
    target.acuteLoad = 2;
    target.chronicLoad = 3;
    target.workloadRatio = 0.4;

    const result = mobileTrainingFixtureSchema.safeParse(fixture);
    for (const field of [
      "currentStrain",
      "dailyLoad",
      "acuteLoad",
      "chronicLoad",
      "workloadRatio",
    ]) {
      expectIssue(
        result,
        ["data", "strainTarget", field],
        `${field} must match the displayed workload point`,
      );
    }
  });

  it("does not compare a strain target with a historical displayed date", () => {
    const fixture = validTrainingFixture();
    fixture.data.workloadRatio.displayedDate = "2026-07-26";
    fixture.data.workloadRatio.displayedStrain = 11.8;
    const target = fixture.data.strainTarget;
    if (target === undefined) throw new Error("Missing strain target fixture");
    target.currentStrain = 8;
    target.dailyLoad = 1;
    target.acuteLoad = 2;
    target.chronicLoad = 3;
    target.workloadRatio = 0.4;

    expect(mobileTrainingFixtureSchema.safeParse(fixture).success).toBe(true);
  });

  it("accepts a current workload display without a strain target", () => {
    const fixture = validTrainingFixture();
    delete fixture.data.strainTarget;

    expect(mobileTrainingFixtureSchema.safeParse(fixture).success).toBe(true);
  });

  it("accepts an intentionally unselected workload display", () => {
    const fixture = validTrainingFixture();
    fixture.data.workloadRatio.displayedDate = null;
    delete fixture.data.strainTarget;

    expect(mobileTrainingFixtureSchema.safeParse(fixture).success).toBe(true);
  });

  it("rejects weekly activity counts that contradict the activity cards", () => {
    const fixture = validTrainingFixture();
    const cyclingVolume = fixture.data.weeklyVolume[0];
    if (!cyclingVolume) throw new Error("Missing cycling volume fixture");
    cyclingVolume.count = 3;

    expectIssue(
      mobileTrainingFixtureSchema.safeParse(fixture),
      ["data", "weeklyVolume"],
      "Weekly cycling count must match the fixture activities",
    );
  });

  it.each([
    [
      "workload",
      (fixture: z.input<typeof mobileTrainingFixtureSchema>) => {
        first(fixture.data.workloadRatio.timeSeries, "workload").date = "2026-06-27";
      },
    ],
    [
      "activity",
      (fixture: z.input<typeof mobileTrainingFixtureSchema>) => {
        first(fixture.data.activities, "activity").started_at = "2026-06-27T07:00:00.000Z";
      },
    ],
    [
      "vertical ascent",
      (fixture: z.input<typeof mobileTrainingFixtureSchema>) => {
        fixture.data.verticalAscent.push({
          date: "2026-06-27",
          activityName: "Hill repeats",
          activityType: "running",
          modality: null,
          verticalAscentRate: 10,
          elevationGainMeters: 300,
          elapsedMinutes: 30,
        });
      },
    ],
    [
      "climbing grade progression",
      (fixture: z.input<typeof mobileTrainingFixtureSchema>) => {
        fixture.data.climbing.gradeProgression.push({
          date: "2026-06-27",
          climbType: "boulder",
          gradeSystem: "v_scale",
          grade: "V5",
          gradeSortValue: 5,
        });
      },
    ],
    [
      "climbing session",
      (fixture: z.input<typeof mobileTrainingFixtureSchema>) => {
        fixture.data.climbing.sessionSummary.push({
          activityId: "climb-1",
          date: "2026-06-27",
          name: "Gym session",
          locationName: null,
          attempts: 8,
          sends: 5,
          hardestBoulderGrade: "V5",
          hardestBoulderGradeSortValue: 5,
          hardestRouteGrade: null,
          hardestRouteGradeSortValue: null,
        });
      },
    ],
  ])("rejects an out-of-window %s date", (_label, moveOutsideWindow) => {
    const fixture = validTrainingFixture();
    moveOutsideWindow(fixture);

    expectIssue(
      mobileTrainingFixtureSchema.safeParse(fixture),
      [],
      "Fixture date 2026-06-27 is outside 2026-06-28..2026-07-27",
    );
  });

  it("rejects weekly volume rows that do not start on Monday", () => {
    const fixture = validTrainingFixture();
    const cyclingVolume = fixture.data.weeklyVolume[0];
    if (!cyclingVolume) throw new Error("Missing cycling volume fixture");
    cyclingVolume.week = "2026-07-26";

    expectIssue(
      mobileTrainingFixtureSchema.safeParse(fixture),
      [],
      "Fixture week 2026-07-26 must start on Monday",
    );
  });

  it("rejects a selected workload date with no row or a mismatched strain", () => {
    const missingRow = validTrainingFixture();
    missingRow.data.workloadRatio.displayedDate = "2026-07-25";
    expectIssue(
      mobileTrainingFixtureSchema.safeParse(missingRow),
      ["data", "workloadRatio", "displayedStrain"],
      "Displayed strain and date must identify a matching time-series point",
    );

    const mismatchedStrain = validTrainingFixture();
    mismatchedStrain.data.workloadRatio.displayedStrain = 8;
    expectIssue(
      mobileTrainingFixtureSchema.safeParse(mismatchedStrain),
      ["data", "workloadRatio", "displayedStrain"],
      "Displayed strain and date must identify a matching time-series point",
    );
  });

  it("accepts an activity without an end time when weekly duration is zero", () => {
    const fixture = validTrainingFixture();
    fixture.data.activities = [
      {
        id: "open-activity",
        name: "Open activity",
        canonical_type: "walking",
        started_at: "2026-07-27T07:00:00.000Z",
        ended_at: null,
        avg_hr: null,
        max_hr: null,
        avg_power: null,
        max_power: null,
        avg_cadence: null,
        hr_samples: null,
        power_samples: null,
        distance_meters: null,
        distance_state: { status: "missing", reason: "Distance not recorded" },
      },
    ];
    fixture.data.weeklyVolume = [
      { week: "2026-07-27", canonical_type: "walking", count: 1, hours: 0 },
    ];

    expect(mobileTrainingFixtureSchema.safeParse(fixture).success).toBe(true);
  });

  it("rejects weekly hours that contradict completed activity durations", () => {
    const fixture = validTrainingFixture();
    first(fixture.data.weeklyVolume, "cycling volume").hours = 2;

    expectIssue(
      mobileTrainingFixtureSchema.safeParse(fixture),
      ["data", "weeklyVolume"],
      "Weekly cycling hours must match the fixture activity durations",
    );
  });

  it("rejects activity types present on only one side of the weekly summary", () => {
    const activityOnly = validTrainingFixture();
    activityOnly.data.activities.push({
      id: "walk-1",
      name: "Walk",
      canonical_type: "walking",
      started_at: "2026-07-27T09:00:00.000Z",
      ended_at: null,
      avg_hr: null,
      max_hr: null,
      avg_power: null,
      max_power: null,
      avg_cadence: null,
      hr_samples: null,
      power_samples: null,
      distance_meters: null,
      distance_state: { status: "missing", reason: "Distance not recorded" },
    });
    expectIssue(
      mobileTrainingFixtureSchema.safeParse(activityOnly),
      ["data", "weeklyVolume"],
      "Weekly walking count must match the fixture activities",
    );

    const weeklyOnly = validTrainingFixture();
    weeklyOnly.data.weeklyVolume.push({
      week: "2026-07-27",
      canonical_type: "swimming",
      count: 1,
      hours: 0,
    });
    expectIssue(
      mobileTrainingFixtureSchema.safeParse(weeklyOnly),
      ["data", "weeklyVolume"],
      "Weekly swimming count must match the fixture activities",
    );
  });
});

describe("canonical mobile dashboard output types", () => {
  it("match the public service result types", () => {
    expectTypeOf<ServiceMobileRecoveryTabResult>().toEqualTypeOf<MobileRecoveryTabResult>();
    expectTypeOf<ServiceMobileTrainingTabResult>().toEqualTypeOf<MobileTrainingTabResult>();
    expectTypeOf<ServiceWorkloadRatioResult>().toEqualTypeOf<WorkloadRatioResult>();
  });
});
