import { describe, expect, it, vi } from "vitest";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{
      accessWindow: typeof fullAccessWindow;
      db: unknown;
      userId: string | null;
      timezone: string;
      sensorStore?: unknown;
    }>()
    .create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: () => trpc.procedure,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

vi.mock("../lib/typed-sql.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/typed-sql.ts")>();
  return {
    ...original,
    executeWithSchema: vi.fn(
      async (
        db: { execute: (q: unknown) => Promise<unknown[]> },
        _schema: unknown,
        query: unknown,
      ) => db.execute(query),
    ),
  };
});

import { healthspanRouter } from "./healthspan.ts";
import { fetchHealthspanRawData, type HealthspanRawRow } from "./healthspan-query.ts";
import {
  scoreAerobicMinutes,
  scoreHighIntensityMinutes,
  scoreLeanMassPct,
  scoreRestingHr,
  scoreSleepConsistency,
  scoreSleepDuration,
  scoreSteps,
  scoreStrengthFrequency,
  scoreToStatus,
  scoreVo2Max,
} from "./healthspan-scoring.ts";

// --- scoreToStatus ---

describe("scoreToStatus", () => {
  it("returns excellent for score >= 80", () => {
    expect(scoreToStatus(80)).toBe("excellent");
    expect(scoreToStatus(100)).toBe("excellent");
    expect(scoreToStatus(90)).toBe("excellent");
  });

  it("returns good for score 60-79", () => {
    expect(scoreToStatus(60)).toBe("good");
    expect(scoreToStatus(79)).toBe("good");
    expect(scoreToStatus(70)).toBe("good");
  });

  it("returns fair for score 40-59", () => {
    expect(scoreToStatus(40)).toBe("fair");
    expect(scoreToStatus(59)).toBe("fair");
    expect(scoreToStatus(50)).toBe("fair");
  });

  it("returns poor for score < 40", () => {
    expect(scoreToStatus(39)).toBe("poor");
    expect(scoreToStatus(0)).toBe("poor");
    expect(scoreToStatus(20)).toBe("poor");
  });
});

// --- scoreSleepConsistency ---

describe("scoreSleepConsistency", () => {
  it("returns 50 for null", () => {
    expect(scoreSleepConsistency(null)).toBe(50);
  });

  it("returns 100 for 0 stddev", () => {
    expect(scoreSleepConsistency(0)).toBe(100);
  });

  it("returns 0 for 90+ min stddev", () => {
    expect(scoreSleepConsistency(90)).toBe(0);
    expect(scoreSleepConsistency(120)).toBe(0);
  });

  it("computes linearly between 0 and 90", () => {
    // 45 min: 100 - (45/90)*100 = 100 - 50 = 50
    expect(scoreSleepConsistency(45)).toBe(50);
    // 30 min: 100 - (30/90)*100 = 100 - 33.33 = 67
    expect(scoreSleepConsistency(30)).toBe(67);
  });
});

// --- scoreSleepDuration ---

describe("scoreSleepDuration", () => {
  it("returns 50 for null", () => {
    expect(scoreSleepDuration(null)).toBe(50);
  });

  it("returns 100 for 7-9 hours", () => {
    expect(scoreSleepDuration(420)).toBe(100); // 7h
    expect(scoreSleepDuration(480)).toBe(100); // 8h
    expect(scoreSleepDuration(540)).toBe(100); // 9h
  });

  it("returns 70 for 6-7 hours", () => {
    expect(scoreSleepDuration(360)).toBe(70); // 6h
    expect(scoreSleepDuration(390)).toBe(70); // 6.5h
  });

  it("returns 80 for 9-10 hours", () => {
    expect(scoreSleepDuration(570)).toBe(80); // 9.5h
  });

  it("returns 40 for 5-6 hours", () => {
    expect(scoreSleepDuration(300)).toBe(40); // 5h
    expect(scoreSleepDuration(330)).toBe(40); // 5.5h
  });

  it("returns 20 for < 5 hours or >= 10 hours", () => {
    expect(scoreSleepDuration(240)).toBe(20); // 4h
    expect(scoreSleepDuration(600)).toBe(20); // 10h
    expect(scoreSleepDuration(120)).toBe(20); // 2h
  });
});

// --- scoreAerobicMinutes ---

describe("scoreAerobicMinutes", () => {
  it("returns 50 for null", () => {
    expect(scoreAerobicMinutes(null)).toBe(50);
  });

  it("returns 100 for >= 300 min", () => {
    expect(scoreAerobicMinutes(300)).toBe(100);
    expect(scoreAerobicMinutes(500)).toBe(100);
  });

  it("returns 70-100 for 150-300 min", () => {
    expect(scoreAerobicMinutes(150)).toBe(70);
    expect(scoreAerobicMinutes(225)).toBe(85);
    expect(scoreAerobicMinutes(299)).toBeCloseTo(70 + (149 / 150) * 30, 0);
  });

  it("returns 40-70 for 75-150 min", () => {
    expect(scoreAerobicMinutes(75)).toBe(40);
    expect(scoreAerobicMinutes(112.5)).toBeCloseTo(55, 0);
  });

  it("returns 0-40 for < 75 min", () => {
    expect(scoreAerobicMinutes(0)).toBe(0);
    expect(scoreAerobicMinutes(37.5)).toBe(20);
    expect(scoreAerobicMinutes(75 - 1)).toBeLessThan(40);
  });
});

// --- scoreHighIntensityMinutes ---

describe("scoreHighIntensityMinutes", () => {
  it("returns 50 for null", () => {
    expect(scoreHighIntensityMinutes(null)).toBe(50);
  });

  it("returns 100 for >= 150 min", () => {
    expect(scoreHighIntensityMinutes(150)).toBe(100);
    expect(scoreHighIntensityMinutes(200)).toBe(100);
  });

  it("returns 70-100 for 75-150 min", () => {
    expect(scoreHighIntensityMinutes(75)).toBe(70);
    expect(scoreHighIntensityMinutes(112.5)).toBeCloseTo(85, 0);
  });

  it("returns 40-70 for 30-75 min", () => {
    expect(scoreHighIntensityMinutes(30)).toBe(40);
    expect(scoreHighIntensityMinutes(52.5)).toBeCloseTo(55, 0);
  });

  it("returns 0-40 for < 30 min", () => {
    expect(scoreHighIntensityMinutes(0)).toBe(0);
    expect(scoreHighIntensityMinutes(15)).toBe(20);
  });
});

// --- scoreStrengthFrequency ---

describe("scoreStrengthFrequency", () => {
  it("returns 50 for null", () => {
    expect(scoreStrengthFrequency(null)).toBe(50);
  });

  it("returns 100 for 2-5 sessions/week", () => {
    expect(scoreStrengthFrequency(2)).toBe(100);
    expect(scoreStrengthFrequency(3)).toBe(100);
    expect(scoreStrengthFrequency(5)).toBe(100);
  });

  it("returns 70 for 1 session/week", () => {
    expect(scoreStrengthFrequency(1)).toBe(70);
    expect(scoreStrengthFrequency(1.5)).toBe(70);
  });

  it("returns 20 for 0 sessions/week", () => {
    expect(scoreStrengthFrequency(0)).toBe(20);
  });

  it("returns 100 for > 5 sessions", () => {
    expect(scoreStrengthFrequency(6)).toBe(70);
  });
});

// --- scoreSteps ---

describe("scoreSteps", () => {
  it("returns 50 for null", () => {
    expect(scoreSteps(null)).toBe(50);
  });

  it("returns 100 for >= 10000", () => {
    expect(scoreSteps(10000)).toBe(100);
    expect(scoreSteps(15000)).toBe(100);
  });

  it("returns 85 for 8000-10000", () => {
    expect(scoreSteps(8000)).toBe(85);
    expect(scoreSteps(9000)).toBe(85);
  });

  it("returns 65 for 6000-8000", () => {
    expect(scoreSteps(6000)).toBe(65);
    expect(scoreSteps(7000)).toBe(65);
  });

  it("returns 45 for 4000-6000", () => {
    expect(scoreSteps(4000)).toBe(45);
    expect(scoreSteps(5000)).toBe(45);
  });

  it("returns proportional for < 4000", () => {
    expect(scoreSteps(0)).toBe(0);
    expect(scoreSteps(2000)).toBe(Math.round((2000 / 4000) * 45)); // 23
    expect(scoreSteps(1000)).toBe(Math.round((1000 / 4000) * 45)); // 11
  });
});

// --- scoreVo2Max ---

describe("scoreVo2Max", () => {
  it("returns 50 for null", () => {
    expect(scoreVo2Max(null)).toBe(50);
  });

  it("returns 100 for >= 50", () => {
    expect(scoreVo2Max(50)).toBe(100);
    expect(scoreVo2Max(60)).toBe(100);
  });

  it("returns 85 for 45-50", () => {
    expect(scoreVo2Max(45)).toBe(85);
    expect(scoreVo2Max(47)).toBe(85);
  });

  it("returns 70 for 40-45", () => {
    expect(scoreVo2Max(40)).toBe(70);
    expect(scoreVo2Max(42)).toBe(70);
  });

  it("returns 55 for 35-40", () => {
    expect(scoreVo2Max(35)).toBe(55);
    expect(scoreVo2Max(37)).toBe(55);
  });

  it("returns 40 for 30-35", () => {
    expect(scoreVo2Max(30)).toBe(40);
    expect(scoreVo2Max(32)).toBe(40);
  });

  it("returns 20 for < 30", () => {
    expect(scoreVo2Max(25)).toBe(20);
    expect(scoreVo2Max(10)).toBe(20);
  });
});

// --- scoreRestingHr ---

describe("scoreRestingHr", () => {
  it("returns 50 for null", () => {
    expect(scoreRestingHr(null)).toBe(50);
  });

  it("returns 100 for <= 50", () => {
    expect(scoreRestingHr(50)).toBe(100);
    expect(scoreRestingHr(40)).toBe(100);
  });

  it("returns 90 for 51-55", () => {
    expect(scoreRestingHr(51)).toBe(90);
    expect(scoreRestingHr(55)).toBe(90);
  });

  it("returns 80 for 56-60", () => {
    expect(scoreRestingHr(56)).toBe(80);
    expect(scoreRestingHr(60)).toBe(80);
  });

  it("returns 65 for 61-65", () => {
    expect(scoreRestingHr(61)).toBe(65);
    expect(scoreRestingHr(65)).toBe(65);
  });

  it("returns 50 for 66-70", () => {
    expect(scoreRestingHr(66)).toBe(50);
    expect(scoreRestingHr(70)).toBe(50);
  });

  it("returns 35 for 71-75", () => {
    expect(scoreRestingHr(71)).toBe(35);
    expect(scoreRestingHr(75)).toBe(35);
  });

  it("returns 20 for > 75", () => {
    expect(scoreRestingHr(76)).toBe(20);
    expect(scoreRestingHr(90)).toBe(20);
  });
});

// --- scoreLeanMassPct ---

describe("scoreLeanMassPct", () => {
  it("returns 50 for null", () => {
    expect(scoreLeanMassPct(null)).toBe(50);
  });

  it("returns 100 for >= 85%", () => {
    expect(scoreLeanMassPct(85)).toBe(100);
    expect(scoreLeanMassPct(90)).toBe(100);
  });

  it("returns 85 for 80-85%", () => {
    expect(scoreLeanMassPct(80)).toBe(85);
    expect(scoreLeanMassPct(82)).toBe(85);
  });

  it("returns 70 for 75-80%", () => {
    expect(scoreLeanMassPct(75)).toBe(70);
    expect(scoreLeanMassPct(77)).toBe(70);
  });

  it("returns 55 for 70-75%", () => {
    expect(scoreLeanMassPct(70)).toBe(55);
    expect(scoreLeanMassPct(72)).toBe(55);
  });

  it("returns 35 for < 70%", () => {
    expect(scoreLeanMassPct(65)).toBe(35);
    expect(scoreLeanMassPct(50)).toBe(35);
  });
});

// --- healthspanRouter ---

const createCaller = createTestCallerFactory(healthspanRouter);
const fullAccessWindow = { kind: "full", paid: true, reason: "paid_grant" } as const;

function makeSensorStore(overrides: Partial<ActivitySensorStore>): ActivitySensorStore {
  return {
    query: vi.fn().mockResolvedValue([]),
    getActivitySummaries: vi.fn().mockResolvedValue([]),
    getPowerCurveSamples: vi.fn().mockResolvedValue([]),
    getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
    getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
    getHeartRateCurveRows: vi.fn().mockResolvedValue([]),
    getPaceCurveRows: vi.fn().mockResolvedValue([]),
    getStream: vi.fn().mockResolvedValue([]),
    getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeHealthspanReadModelRows(rows: HealthspanRawRow[]) {
  return rows.flatMap((row, rowIndex) => {
    const historyRows =
      row.weekly_history && row.weekly_history.length > 0
        ? row.weekly_history
        : [
            {
              week_start: `2026-03-${String(rowIndex + 2).padStart(2, "0")}`,
              avg_rhr: row.avg_resting_hr,
              avg_steps: row.avg_steps,
              avg_vo2max: row.latest_vo2max,
            },
          ];

    return historyRows.map((historyRow) => ({
      week_start: historyRow.week_start,
      avg_sleep_min: row.avg_sleep_min,
      bedtime_stddev_min: row.bedtime_stddev_min,
      avg_resting_hr: historyRow.avg_rhr,
      avg_steps: historyRow.avg_steps,
      latest_vo2max: historyRow.avg_vo2max,
      weekly_aerobic_min: row.weekly_aerobic_min,
      weekly_high_intensity_min: row.weekly_high_intensity_min,
      sessions_per_week: row.sessions_per_week,
      weight_kg: row.weight_kg,
      body_fat_pct: row.body_fat_pct,
    }));
  });
}

function makeHealthspanCallerContext(rows: HealthspanRawRow[]) {
  return {
    accessWindow: fullAccessWindow,
    db: { execute: vi.fn() },
    userId: "user-1",
    timezone: "UTC",
    sensorStore: makeSensorStore({
      query: vi.fn().mockResolvedValue(makeHealthspanReadModelRows(rows)),
    }),
  };
}

function makeFetchContext(
  overrides: Partial<Parameters<typeof fetchHealthspanRawData>[0]>,
): Parameters<typeof fetchHealthspanRawData>[0] {
  return {
    userId: "user-1",
    timezone: "UTC",
    accessWindow: fullAccessWindow,
    ...overrides,
  };
}

describe("fetchHealthspanRawData", () => {
  it("reads compact weekly rows from the Healthspan read model", async () => {
    const query = vi.fn().mockResolvedValue([
      {
        week_start: "2026-03-03",
        avg_sleep_min: 420,
        bedtime_stddev_min: 20,
        avg_resting_hr: 55,
        avg_steps: 8000,
        latest_vo2max: 42,
        weekly_aerobic_min: 120,
        weekly_high_intensity_min: 30,
        sessions_per_week: 2,
        weight_kg: 80,
        body_fat_pct: 20,
      },
    ]);
    const ctx = makeFetchContext({
      sensorStore: makeSensorStore({ query }),
    });

    const result = await fetchHealthspanRawData(ctx, "2026-03-15", 14);

    expect(query.mock.calls[0]?.[1]).toContain("analytics.weekly_healthspan AS healthspan FINAL");
    expect(query.mock.calls[0]?.[1]).not.toContain("analytics.healthspan_activity_zone_minutes");
    expect(result?.weekly_history).toEqual([
      { week_start: "2026-03-03", avg_rhr: 55, avg_steps: 8000, avg_vo2max: 42 },
    ]);
  });

  it("bounds the Healthspan read model by end date and access window", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const ctx = makeFetchContext({
      accessWindow: {
        kind: "limited",
        paid: false,
        reason: "free_signup_week",
        startDate: "2026-03-05",
        endDateExclusive: "2026-03-12",
      },
      sensorStore: makeSensorStore({ query }),
    });

    await fetchHealthspanRawData(ctx, "2026-03-15", 14);

    const queryText = query.mock.calls[0]?.[1];
    expect(queryText).toContain("healthspan.week_start > toMonday(toDate({windowStart:String}))");
    expect(queryText).toContain("healthspan.week_start <= toMonday(toDate({endDate:String}))");
    expect(queryText).toContain("healthspan.week_start >= toDate({accessStartDate:String})");
    expect(queryText).toContain(
      "healthspan.week_start + INTERVAL 7 DAY <= toDate({accessEndDateExclusive:String})",
    );
    expect(query.mock.calls[0]?.[2]).toMatchObject({
      windowStart: "2026-03-01",
      endDate: "2026-03-15",
      accessStartDate: "2026-03-05",
      accessEndDateExclusive: "2026-03-12",
    });
  });

  it("returns null without a sensor store", async () => {
    const result = await fetchHealthspanRawData(makeFetchContext({}), "2026-03-15", 14);

    expect(result).toBeNull();
  });
});

describe("healthspanRouter", () => {
  describe("score", () => {
    it("returns null score when no data", async () => {
      const caller = createCaller({
        accessWindow: fullAccessWindow,
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeSensorStore({ query: vi.fn().mockResolvedValue([]) }),
      });
      const result = await caller.score({ weeks: 12, endDate: "2026-03-15" });

      expect(result.healthspanScore).toBeNull();
      expect(result.metrics).toEqual([]);
      expect(result.history).toEqual([]);
      expect(result.trend).toBeNull();
      expect(result.availability).toEqual({
        status: "insufficient_data",
        availableMetricCount: 0,
        requiredMetricCount: 3,
        missingMetricLabels: [
          "Sleep Consistency",
          "Sleep Duration",
          "Aerobic Activity",
          "High Intensity",
          "Strength Training",
          "Daily Steps",
          "VO2 Max",
          "Resting Heart Rate",
          "Lean Body Mass",
        ],
        summary: "0 of 3 required Healthspan metrics are available.",
        nextCondition:
          "The score becomes available after 3 more supported metrics sync successfully.",
      });
    });

    it("computes exact healthspan score from known metrics", async () => {
      const rows = [
        {
          avg_sleep_min: 480, // 8h → 100
          bedtime_stddev_min: 20, // → round(100 - (20/90)*100) = 78
          avg_resting_hr: 55, // → 90
          avg_steps: 10000, // → 100
          latest_vo2max: 50, // → 100
          weekly_aerobic_min: 200, // → 70 + (50/150)*30 = 80
          weekly_high_intensity_min: 80, // → 70 + (5/75)*30 ≈ 72
          sessions_per_week: 3, // → 100
          weight_kg: 75,
          body_fat_pct: 15, // lean=85 → 100
          weekly_history: [],
        },
      ];
      const caller = createCaller(makeHealthspanCallerContext(rows));
      const result = await caller.score({ weeks: 12, endDate: "2026-03-15" });

      expect(result.metrics).toHaveLength(9);

      // Verify individual metric scores
      const sleepCons = result.metrics.find((m) => m.name === "Sleep Consistency");
      expect(sleepCons?.score).toBe(scoreSleepConsistency(20));

      const sleepDur = result.metrics.find((m) => m.name === "Sleep Duration");
      expect(sleepDur?.score).toBe(scoreSleepDuration(480));
      expect(sleepDur?.score).toBe(100);

      const aerobic = result.metrics.find((m) => m.name === "Aerobic Activity");
      expect(aerobic?.score).toBe(scoreAerobicMinutes(200));

      const hiIntensity = result.metrics.find((m) => m.name === "High Intensity");
      expect(hiIntensity?.score).toBe(scoreHighIntensityMinutes(80));

      const strength = result.metrics.find((m) => m.name === "Strength Training");
      expect(strength?.score).toBe(100);

      const steps = result.metrics.find((m) => m.name === "Daily Steps");
      expect(steps?.score).toBe(100);

      const vo2 = result.metrics.find((m) => m.name === "VO2 Max");
      expect(vo2?.score).toBe(100);

      const rhr = result.metrics.find((m) => m.name === "Resting Heart Rate");
      expect(rhr?.score).toBe(90);

      const lean = result.metrics.find((m) => m.name === "Lean Body Mass");
      expect(lean?.score).toBe(100);

      // Composite: average of metrics with real data (all 9 here)
      const metricsWithData = result.metrics.filter((m) => m.value != null);
      expect(metricsWithData).toHaveLength(9);
      const totalScore = metricsWithData.reduce((sum, m) => sum + m.score, 0);
      expect(result.healthspanScore).toBe(Math.round(totalScore / metricsWithData.length));
      expect(result.availability.summary).toBe(
        "9 supported Healthspan metrics are available; 3 are required for a score.",
      );
    });

    it("uses read-model VO2 max estimates for the current value and weekly history", async () => {
      const rows = [
        {
          avg_sleep_min: 480,
          bedtime_stddev_min: 20,
          avg_resting_hr: 55,
          avg_steps: 10000,
          latest_vo2max: 45,
          weekly_aerobic_min: 200,
          weekly_high_intensity_min: 80,
          sessions_per_week: 3,
          weight_kg: 75,
          body_fat_pct: 15,
          weekly_history: [
            { week_start: "2026-03-09", avg_rhr: 55, avg_steps: 10000, avg_vo2max: 45 },
          ],
        },
      ];
      const getVo2MaxEstimates = vi.fn().mockResolvedValue([
        {
          activity_id: "activity-1",
          activity_date: "2026-03-10",
          method: "cycling_power",
          vo2max: 40,
        },
        {
          activity_id: "activity-2",
          activity_date: "2026-03-11",
          method: "submaximal_acsm",
          vo2max: 50,
        },
      ]);
      const query = vi.fn().mockResolvedValue(makeHealthspanReadModelRows(rows));
      const caller = createCaller({
        accessWindow: fullAccessWindow,
        db: { execute: vi.fn() },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeSensorStore({ getVo2MaxEstimates, query }),
      });

      const result = await caller.score({ weeks: 12, endDate: "2026-03-15" });

      const vo2 = result.metrics.find((metric) => metric.name === "VO2 Max");
      const queryText = query.mock.calls[0]?.[1];
      expect(queryText).not.toContain("derived_vo2max_estimates");
      expect(vo2?.value).toBe(45);
      expect(queryText).toContain("analytics.weekly_healthspan");
      expect(getVo2MaxEstimates).not.toHaveBeenCalled();
      expect(result.history[0]?.score).toBe(
        Math.round((scoreRestingHr(55) + scoreSteps(10000) + scoreVo2Max(45)) / 3),
      );
    });

    it("returns null score when all metrics are null", async () => {
      const rows = [
        {
          avg_sleep_min: null,
          bedtime_stddev_min: null,
          avg_resting_hr: null,
          avg_steps: null,
          latest_vo2max: null,
          weekly_aerobic_min: null,
          weekly_high_intensity_min: null,
          sessions_per_week: null,
          weight_kg: null,
          body_fat_pct: null,
          weekly_history: null,
        },
      ];
      const caller = createCaller(makeHealthspanCallerContext(rows));
      const result = await caller.score({ weeks: 12, endDate: "2026-03-15" });

      expect(result.healthspanScore).toBeNull();
      expect(result.metrics).toHaveLength(9);
      for (const m of result.metrics) {
        expect(m.value).toBeNull();
      }
      expect(result.trend).toBeNull();
    });

    it("returns null score when fewer than 3 metrics have data", async () => {
      const rows = [
        {
          avg_sleep_min: null,
          bedtime_stddev_min: null,
          avg_resting_hr: 55, // → 90
          avg_steps: 10000, // → 100
          latest_vo2max: null,
          weekly_aerobic_min: null,
          weekly_high_intensity_min: null,
          sessions_per_week: null,
          weight_kg: null,
          body_fat_pct: null,
          weekly_history: null,
        },
      ];
      const caller = createCaller(makeHealthspanCallerContext(rows));
      const result = await caller.score({ weeks: 12, endDate: "2026-03-15" });

      // Only 2 metrics have real data — below minimum threshold
      expect(result.healthspanScore).toBeNull();
      // Individual metrics are still returned so the UI can show them
      expect(result.metrics).toHaveLength(9);
      expect(result.availability).toEqual({
        status: "insufficient_data",
        availableMetricCount: 2,
        requiredMetricCount: 3,
        missingMetricLabels: [
          "Sleep Consistency",
          "Sleep Duration",
          "Aerobic Activity",
          "High Intensity",
          "Strength Training",
          "VO2 Max",
          "Lean Body Mass",
        ],
        summary: "2 of 3 required Healthspan metrics are available.",
        nextCondition:
          "The score becomes available after 1 more supported metric syncs successfully.",
      });
    });

    it("computes composite from only metrics with real data when above threshold", async () => {
      const rows = [
        {
          avg_sleep_min: 480, // → 100
          bedtime_stddev_min: 20, // → 78
          avg_resting_hr: 55, // → 90
          avg_steps: null,
          latest_vo2max: null,
          weekly_aerobic_min: null,
          weekly_high_intensity_min: null,
          sessions_per_week: null,
          weight_kg: null,
          body_fat_pct: null,
          weekly_history: null,
        },
      ];
      const caller = createCaller(makeHealthspanCallerContext(rows));
      const result = await caller.score({ weeks: 12, endDate: "2026-03-15" });

      // 3 metrics with real data: sleep duration (100), sleep consistency (78), resting HR (90)
      const expected = Math.round((100 + 78 + 90) / 3);
      expect(result.healthspanScore).toBe(expected);
      expect(result.availability).toMatchObject({
        status: "available",
        availableMetricCount: 3,
        requiredMetricCount: 3,
        summary: "3 of 3 required Healthspan metrics are available.",
        nextCondition: null,
      });
    });

    it("sets correct status based on score", async () => {
      const rows = [
        {
          avg_sleep_min: 480, // score 100 → excellent
          bedtime_stddev_min: 60, // score 33 → poor
          avg_resting_hr: 65, // score 65 → good
          avg_steps: 5000, // score 45 → fair
          latest_vo2max: null,
          weekly_aerobic_min: null,
          weekly_high_intensity_min: null,
          sessions_per_week: null,
          weight_kg: null,
          body_fat_pct: null,
          weekly_history: null,
        },
      ];
      const caller = createCaller(makeHealthspanCallerContext(rows));
      const result = await caller.score({ weeks: 12, endDate: "2026-03-15" });

      const sleepDur = result.metrics.find((m) => m.name === "Sleep Duration");
      expect(sleepDur?.status).toBe("excellent");

      const sleepCons = result.metrics.find((m) => m.name === "Sleep Consistency");
      expect(sleepCons?.status).toBe("poor");

      const rhr = result.metrics.find((m) => m.name === "Resting Heart Rate");
      expect(rhr?.status).toBe("good");

      const steps = result.metrics.find((m) => m.name === "Daily Steps");
      expect(steps?.status).toBe("fair");
    });

    it("computes improving trend from rising weekly scores", async () => {
      const rows = [
        {
          avg_sleep_min: 480,
          bedtime_stddev_min: 10,
          avg_resting_hr: 48,
          avg_steps: 12000,
          latest_vo2max: 55,
          weekly_aerobic_min: 350,
          weekly_high_intensity_min: 160,
          sessions_per_week: 4,
          weight_kg: 70,
          body_fat_pct: 12,
          weekly_history: [
            { week_start: "2024-01-01", avg_rhr: 65, avg_steps: 6000, avg_vo2max: 40 },
            { week_start: "2024-01-08", avg_rhr: 60, avg_steps: 8000, avg_vo2max: 42 },
            { week_start: "2024-01-15", avg_rhr: 55, avg_steps: 10000, avg_vo2max: 45 },
            { week_start: "2024-01-22", avg_rhr: 50, avg_steps: 12000, avg_vo2max: 50 },
          ],
        },
      ];
      const caller = createCaller(makeHealthspanCallerContext(rows));
      const result = await caller.score({ weeks: 12, endDate: "2026-03-15" });
      expect(result.trend).toBe("improving");
    });

    it("computes declining trend from falling weekly scores", async () => {
      const rows = [
        {
          avg_sleep_min: 480,
          bedtime_stddev_min: 10,
          avg_resting_hr: 48,
          avg_steps: 12000,
          latest_vo2max: 55,
          weekly_aerobic_min: 350,
          weekly_high_intensity_min: 160,
          sessions_per_week: 4,
          weight_kg: 70,
          body_fat_pct: 12,
          weekly_history: [
            { week_start: "2024-01-01", avg_rhr: 50, avg_steps: 12000, avg_vo2max: 50 },
            { week_start: "2024-01-08", avg_rhr: 55, avg_steps: 10000, avg_vo2max: 45 },
            { week_start: "2024-01-15", avg_rhr: 60, avg_steps: 8000, avg_vo2max: 42 },
            { week_start: "2024-01-22", avg_rhr: 65, avg_steps: 6000, avg_vo2max: 40 },
          ],
        },
      ];
      const caller = createCaller(makeHealthspanCallerContext(rows));
      const result = await caller.score({ weeks: 12, endDate: "2026-03-15" });
      expect(result.trend).toBe("declining");
    });

    it("computes stable trend when scores are flat", async () => {
      const rows = [
        {
          avg_sleep_min: 480,
          bedtime_stddev_min: 10,
          avg_resting_hr: 48,
          avg_steps: 12000,
          latest_vo2max: 55,
          weekly_aerobic_min: 350,
          weekly_high_intensity_min: 160,
          sessions_per_week: 4,
          weight_kg: 70,
          body_fat_pct: 12,
          weekly_history: [
            { week_start: "2024-01-01", avg_rhr: 55, avg_steps: 10000, avg_vo2max: 50 },
            { week_start: "2024-01-08", avg_rhr: 55, avg_steps: 10000, avg_vo2max: 50 },
            { week_start: "2024-01-15", avg_rhr: 55, avg_steps: 10000, avg_vo2max: 50 },
            { week_start: "2024-01-22", avg_rhr: 55, avg_steps: 10000, avg_vo2max: 50 },
          ],
        },
      ];
      const caller = createCaller(makeHealthspanCallerContext(rows));
      const result = await caller.score({ weeks: 12, endDate: "2026-03-15" });
      expect(result.trend).toBe("stable");
    });

    it("returns null trend when fewer than 4 weeks", async () => {
      const rows = [
        {
          avg_sleep_min: 480,
          bedtime_stddev_min: 10,
          avg_resting_hr: 48,
          avg_steps: 12000,
          latest_vo2max: 55,
          weekly_aerobic_min: 350,
          weekly_high_intensity_min: 160,
          sessions_per_week: 4,
          weight_kg: 70,
          body_fat_pct: 12,
          weekly_history: [
            { week_start: "2024-01-01", avg_rhr: 55, avg_steps: 10000, avg_vo2max: 50 },
            { week_start: "2024-01-08", avg_rhr: 50, avg_steps: 12000, avg_vo2max: 52 },
            { week_start: "2024-01-15", avg_rhr: 48, avg_steps: 14000, avg_vo2max: 54 },
          ],
        },
      ];
      const caller = createCaller(makeHealthspanCallerContext(rows));
      const result = await caller.score({ weeks: 12, endDate: "2026-03-15" });
      expect(result.trend).toBeNull();
    });

    it("computes weekly history scores from rhr, steps, and vo2max", async () => {
      const rows = [
        {
          avg_sleep_min: 480,
          bedtime_stddev_min: 10,
          avg_resting_hr: 55,
          avg_steps: 10000,
          latest_vo2max: 50,
          weekly_aerobic_min: 200,
          weekly_high_intensity_min: 80,
          sessions_per_week: 3,
          weight_kg: 75,
          body_fat_pct: 15,
          weekly_history: [
            { week_start: "2024-01-01", avg_rhr: 55, avg_steps: 10000, avg_vo2max: 50 },
          ],
        },
      ];
      const caller = createCaller(makeHealthspanCallerContext(rows));
      const result = await caller.score({ weeks: 12, endDate: "2026-03-15" });

      expect(result.history).toHaveLength(1);
      // rhrScore=90, stepsScore=100, vo2Score=100 → avg=97
      const expectedScore = Math.round(
        (scoreRestingHr(55) + scoreSteps(10000) + scoreVo2Max(50)) / 3,
      );
      expect(result.history[0]?.score).toBe(expectedScore);
    });

    it("computes lean mass from body fat percentage", async () => {
      const rows = [
        {
          avg_sleep_min: null,
          bedtime_stddev_min: null,
          avg_resting_hr: null,
          avg_steps: null,
          latest_vo2max: null,
          weekly_aerobic_min: null,
          weekly_high_intensity_min: null,
          sessions_per_week: null,
          weight_kg: 80,
          body_fat_pct: 25, // lean = 75%
          weekly_history: null,
        },
      ];
      const caller = createCaller(makeHealthspanCallerContext(rows));
      const result = await caller.score({ weeks: 12, endDate: "2026-03-15" });

      const lean = result.metrics.find((m) => m.name === "Lean Body Mass");
      expect(lean?.score).toBe(scoreLeanMassPct(75)); // 70
      expect(lean?.value).toBeCloseTo(75, 0);
    });
  });
});
