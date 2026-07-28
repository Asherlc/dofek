import { describe, expect, it } from "vitest";
import {
  mobileRecoveryFixtureSchema,
  mobileTrainingFixtureSchema,
} from "./mobile-dashboard-contracts.ts";

const input = {
  days: 30,
  endDate: "2026-07-27",
};

function validRecoveryFixture() {
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
          smoothedWeight: 73.6,
          weeklyChange: -0.2,
          interpolated: false,
        },
      ],
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
      healthStatus: [],
      healthspan: {
        healthspanScore: 84,
        yearsDelta: 1.8,
        metrics: [],
        history: [],
        trend: "improving" as const,
      },
    },
  };
}

function validTrainingFixture() {
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
          activity_type: "cycling",
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
        },
        {
          id: "a2",
          name: "Evening Run",
          activity_type: "running",
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
        },
      ],
      weeklyVolume: [
        { week: "2026-07-27", activity_type: "cycling", count: 1, hours: 1.5 },
        { week: "2026-07-20", activity_type: "running", count: 1, hours: 0.75 },
      ],
      verticalAscent: [],
      climbing: {
        gradeProgression: [],
        volumeByGrade: [],
        sessionSummary: [],
      },
    },
  };
}

describe("mobileRecoveryFixtureSchema", () => {
  it("accepts a complete fixture that matches the runtime output contract", () => {
    expect(mobileRecoveryFixtureSchema.parse(validRecoveryFixture())).toBeTruthy();
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

    expect(mobileRecoveryFixtureSchema.safeParse(fixture).success).toBe(false);
  });

  it("rejects historical rows outside the selected date window", () => {
    const fixture = validRecoveryFixture();
    const firstHrv = fixture.data.hrvVariability[0];
    if (!firstHrv) throw new Error("Missing HRV fixture");
    firstHrv.date = "2026-06-01";

    expect(mobileRecoveryFixtureSchema.safeParse(fixture).success).toBe(false);
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
});

describe("mobileTrainingFixtureSchema", () => {
  it("accepts coherent training claims backed by runtime-valid data", () => {
    expect(mobileTrainingFixtureSchema.parse(validTrainingFixture())).toBeTruthy();
  });

  it("rejects a positive training story whose trend renders as no data", () => {
    const fixture = validTrainingFixture();
    fixture.data.workloadRatio.timeSeries = fixture.data.workloadRatio.timeSeries.slice(-1);

    expect(mobileTrainingFixtureSchema.safeParse(fixture).success).toBe(false);
  });

  it("rejects strain-target values that contradict the displayed workload point", () => {
    const fixture = validTrainingFixture();
    fixture.data.strainTarget.currentStrain = 8.4;

    expect(mobileTrainingFixtureSchema.safeParse(fixture).success).toBe(false);
  });

  it("rejects weekly activity counts that contradict the activity cards", () => {
    const fixture = validTrainingFixture();
    const cyclingVolume = fixture.data.weeklyVolume[0];
    if (!cyclingVolume) throw new Error("Missing cycling volume fixture");
    cyclingVolume.count = 3;

    expect(mobileTrainingFixtureSchema.safeParse(fixture).success).toBe(false);
  });

  it("rejects historical rows outside the selected date window", () => {
    const fixture = validTrainingFixture();
    const firstWorkload = fixture.data.workloadRatio.timeSeries[0];
    if (!firstWorkload) throw new Error("Missing workload fixture");
    firstWorkload.date = "2026-03-31";

    expect(mobileTrainingFixtureSchema.safeParse(fixture).success).toBe(false);
  });

  it("rejects weekly volume rows that do not start on Monday", () => {
    const fixture = validTrainingFixture();
    const cyclingVolume = fixture.data.weeklyVolume[0];
    if (!cyclingVolume) throw new Error("Missing cycling volume fixture");
    cyclingVolume.week = "2026-07-26";

    expect(mobileTrainingFixtureSchema.safeParse(fixture).success).toBe(false);
  });
});
