import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/typed-sql.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/typed-sql.ts")>();
  return {
    ...original,
    executeWithSchema: vi.fn(
      async (
        db: { execute: (query: unknown) => Promise<unknown[]> },
        _schema: unknown,
        query: unknown,
      ) => db.execute(query),
    ),
  };
});

import {
  HealthspanRepository,
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
} from "./healthspan-repository.ts";

// ---------------------------------------------------------------------------
// scoreToStatus
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// scoreSleepConsistency
// ---------------------------------------------------------------------------

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
    expect(scoreSleepConsistency(45)).toBe(50);
    expect(scoreSleepConsistency(30)).toBe(67);
  });
});

// ---------------------------------------------------------------------------
// scoreSleepDuration
// ---------------------------------------------------------------------------

describe("scoreSleepDuration", () => {
  it("returns 50 for null", () => {
    expect(scoreSleepDuration(null)).toBe(50);
  });

  it("returns 100 for 7-9 hours", () => {
    expect(scoreSleepDuration(420)).toBe(100);
    expect(scoreSleepDuration(480)).toBe(100);
    expect(scoreSleepDuration(540)).toBe(100);
  });

  it("returns 70 for 6-7 hours", () => {
    expect(scoreSleepDuration(360)).toBe(70);
    expect(scoreSleepDuration(390)).toBe(70);
  });

  it("returns 80 for 9-10 hours", () => {
    expect(scoreSleepDuration(570)).toBe(80);
  });

  it("returns 40 for 5-6 hours", () => {
    expect(scoreSleepDuration(300)).toBe(40);
    expect(scoreSleepDuration(330)).toBe(40);
  });

  it("returns 20 for < 5 hours or >= 10 hours", () => {
    expect(scoreSleepDuration(240)).toBe(20);
    expect(scoreSleepDuration(600)).toBe(20);
    expect(scoreSleepDuration(120)).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// scoreAerobicMinutes
// ---------------------------------------------------------------------------

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
  });

  it("returns 40-70 for 75-150 min", () => {
    expect(scoreAerobicMinutes(75)).toBe(40);
    expect(scoreAerobicMinutes(112.5)).toBeCloseTo(55, 0);
  });

  it("returns 0-40 for < 75 min", () => {
    expect(scoreAerobicMinutes(0)).toBe(0);
    expect(scoreAerobicMinutes(37.5)).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// scoreHighIntensityMinutes
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// scoreStrengthFrequency
// ---------------------------------------------------------------------------

describe("scoreStrengthFrequency", () => {
  it("returns 50 for null", () => {
    expect(scoreStrengthFrequency(null)).toBe(50);
  });

  it("returns 100 for 2-5 sessions/week", () => {
    expect(scoreStrengthFrequency(2)).toBe(100);
    expect(scoreStrengthFrequency(3)).toBe(100);
    expect(scoreStrengthFrequency(5)).toBe(100);
  });

  it("returns 70 for 1-2 sessions/week", () => {
    expect(scoreStrengthFrequency(1)).toBe(70);
    expect(scoreStrengthFrequency(1.5)).toBe(70);
  });

  it("returns 20 for 0 sessions/week", () => {
    expect(scoreStrengthFrequency(0)).toBe(20);
  });

  it("returns 70 for > 5 sessions (above optimal range)", () => {
    expect(scoreStrengthFrequency(6)).toBe(70);
  });
});

// ---------------------------------------------------------------------------
// scoreSteps
// ---------------------------------------------------------------------------

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
    expect(scoreSteps(2000)).toBe(Math.round((2000 / 4000) * 45));
    expect(scoreSteps(1000)).toBe(Math.round((1000 / 4000) * 45));
  });
});

// ---------------------------------------------------------------------------
// scoreVo2Max
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// scoreRestingHr
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// scoreLeanMassPct
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// HealthspanRepository
// ---------------------------------------------------------------------------

function makeDb(rows: Record<string, unknown>[] = []) {
  return { execute: vi.fn().mockResolvedValue(rows) };
}

function makeFullRow(overrides: Record<string, unknown> = {}) {
  return {
    avg_sleep_min: 480,
    bedtime_stddev_min: 20,
    avg_resting_hr: 55,
    avg_steps: 10000,
    latest_vo2max: 50,
    weekly_aerobic_min: 200,
    weekly_high_intensity_min: 80,
    sessions_per_week: 3,
    weight_kg: 75,
    body_fat_pct: 15,
    weekly_history: [],
    ...overrides,
  };
}

describe("HealthspanRepository", () => {
  describe("getScore", () => {
    it("returns null score when no data (empty rows)", async () => {
      const db = makeDb([]);
      const repo = new HealthspanRepository(db, "user-1", "UTC");
      const result = await repo.getScore(12, "2026-03-15");

      expect(result.healthspanScore).toBeNull();
      expect(result.yearsDelta).toBeNull();
      expect(result.metrics).toEqual([]);
      expect(result.history).toEqual([]);
      expect(result.trend).toBeNull();
    });

    it("returns 9 metrics with correct scores from full data", async () => {
      const db = makeDb([makeFullRow()]);
      const repo = new HealthspanRepository(db, "user-1", "UTC");
      const result = await repo.getScore(12, "2026-03-15");

      expect(result.metrics).toHaveLength(9);

      const sleepConsistency = result.metrics.find((metric) => metric.name === "Sleep Consistency");
      expect(sleepConsistency?.score).toBe(scoreSleepConsistency(20));

      const sleepDuration = result.metrics.find((metric) => metric.name === "Sleep Duration");
      expect(sleepDuration?.score).toBe(scoreSleepDuration(480));
      expect(sleepDuration?.score).toBe(100);

      const aerobic = result.metrics.find((metric) => metric.name === "Aerobic Activity");
      expect(aerobic?.score).toBe(scoreAerobicMinutes(200));

      const highIntensity = result.metrics.find((metric) => metric.name === "High Intensity");
      expect(highIntensity?.score).toBe(scoreHighIntensityMinutes(80));

      const strength = result.metrics.find((metric) => metric.name === "Strength Training");
      expect(strength?.score).toBe(100);

      const steps = result.metrics.find((metric) => metric.name === "Daily Steps");
      expect(steps?.score).toBe(100);

      const vo2 = result.metrics.find((metric) => metric.name === "VO2 Max");
      expect(vo2?.score).toBe(100);

      const rhr = result.metrics.find((metric) => metric.name === "Resting Heart Rate");
      expect(rhr?.score).toBe(90);

      const lean = result.metrics.find((metric) => metric.name === "Lean Body Mass");
      expect(lean?.score).toBe(100);
    });

    it("computes composite score as average of metrics with real data", async () => {
      const db = makeDb([makeFullRow()]);
      const repo = new HealthspanRepository(db, "user-1", "UTC");
      const result = await repo.getScore(12, "2026-03-15");

      const metricsWithData = result.metrics.filter((metric) => metric.value != null);
      expect(metricsWithData).toHaveLength(9);
      const totalScore = metricsWithData.reduce((sum, metric) => sum + metric.score, 0);
      expect(result.healthspanScore).toBe(Math.round(totalScore / metricsWithData.length));
    });

    it("returns null score when all metrics are null", async () => {
      const db = makeDb([
        makeFullRow({
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
        }),
      ]);
      const repo = new HealthspanRepository(db, "user-1", "UTC");
      const result = await repo.getScore(12, "2026-03-15");

      expect(result.healthspanScore).toBeNull();
      expect(result.metrics).toHaveLength(9);
      for (const metric of result.metrics) {
        expect(metric.value).toBeNull();
      }
    });

    it("returns null score when fewer than 3 metrics have data", async () => {
      const db = makeDb([
        makeFullRow({
          avg_sleep_min: null,
          bedtime_stddev_min: null,
          avg_resting_hr: 55,
          avg_steps: 10000,
          latest_vo2max: null,
          weekly_aerobic_min: null,
          weekly_high_intensity_min: null,
          sessions_per_week: null,
          weight_kg: null,
          body_fat_pct: null,
        }),
      ]);
      const repo = new HealthspanRepository(db, "user-1", "UTC");
      const result = await repo.getScore(12, "2026-03-15");

      expect(result.healthspanScore).toBeNull();
      expect(result.metrics).toHaveLength(9);
    });

    it("computes composite from only metrics with real data when at least 3 present", async () => {
      const db = makeDb([
        makeFullRow({
          avg_sleep_min: 480,
          bedtime_stddev_min: 20,
          avg_resting_hr: 55,
          avg_steps: null,
          latest_vo2max: null,
          weekly_aerobic_min: null,
          weekly_high_intensity_min: null,
          sessions_per_week: null,
          weight_kg: null,
          body_fat_pct: null,
        }),
      ]);
      const repo = new HealthspanRepository(db, "user-1", "UTC");
      const result = await repo.getScore(12, "2026-03-15");

      // 3 metrics with data: sleep duration (100), sleep consistency (78), resting HR (90)
      const expected = Math.round((100 + 78 + 90) / 3);
      expect(result.healthspanScore).toBe(expected);
    });

    it("sets correct status on each metric based on score", async () => {
      const db = makeDb([
        makeFullRow({
          avg_sleep_min: 480, // score 100 -> excellent
          bedtime_stddev_min: 60, // score 33 -> poor
          avg_resting_hr: 65, // score 65 -> good
          avg_steps: 5000, // score 45 -> fair
        }),
      ]);
      const repo = new HealthspanRepository(db, "user-1", "UTC");
      const result = await repo.getScore(12, "2026-03-15");

      const sleepDuration = result.metrics.find((metric) => metric.name === "Sleep Duration");
      expect(sleepDuration?.status).toBe("excellent");

      const sleepConsistency = result.metrics.find((metric) => metric.name === "Sleep Consistency");
      expect(sleepConsistency?.status).toBe("poor");

      const rhr = result.metrics.find((metric) => metric.name === "Resting Heart Rate");
      expect(rhr?.status).toBe("good");

      const steps = result.metrics.find((metric) => metric.name === "Daily Steps");
      expect(steps?.status).toBe("fair");
    });

    it("computes lean mass from body fat percentage", async () => {
      const db = makeDb([
        makeFullRow({
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
        }),
      ]);
      const repo = new HealthspanRepository(db, "user-1", "UTC");
      const result = await repo.getScore(12, "2026-03-15");

      const lean = result.metrics.find((metric) => metric.name === "Lean Body Mass");
      expect(lean?.score).toBe(scoreLeanMassPct(75));
      expect(lean?.value).toBeCloseTo(75, 0);
    });

    it("computes weekly history scores from rhr, steps, and vo2max", async () => {
      const db = makeDb([
        makeFullRow({
          weekly_history: [
            { week_start: "2024-01-01", avg_rhr: 55, avg_steps: 10000, avg_vo2max: 50 },
          ],
        }),
      ]);
      const repo = new HealthspanRepository(db, "user-1", "UTC");
      const result = await repo.getScore(12, "2026-03-15");

      expect(result.history).toHaveLength(1);
      const expectedScore = Math.round(
        (scoreRestingHr(55) + scoreSteps(10000) + scoreVo2Max(50)) / 3,
      );
      expect(result.history[0]?.score).toBe(expectedScore);
    });
  });

  describe("trend analysis", () => {
    it("returns improving trend from rising weekly scores", async () => {
      const db = makeDb([
        makeFullRow({
          weekly_history: [
            { week_start: "2024-01-01", avg_rhr: 65, avg_steps: 6000, avg_vo2max: 40 },
            { week_start: "2024-01-08", avg_rhr: 60, avg_steps: 8000, avg_vo2max: 42 },
            { week_start: "2024-01-15", avg_rhr: 55, avg_steps: 10000, avg_vo2max: 45 },
            { week_start: "2024-01-22", avg_rhr: 50, avg_steps: 12000, avg_vo2max: 50 },
          ],
        }),
      ]);
      const repo = new HealthspanRepository(db, "user-1", "UTC");
      const result = await repo.getScore(12, "2026-03-15");
      expect(result.trend).toBe("improving");
    });

    it("returns declining trend from falling weekly scores", async () => {
      const db = makeDb([
        makeFullRow({
          weekly_history: [
            { week_start: "2024-01-01", avg_rhr: 50, avg_steps: 12000, avg_vo2max: 50 },
            { week_start: "2024-01-08", avg_rhr: 55, avg_steps: 10000, avg_vo2max: 45 },
            { week_start: "2024-01-15", avg_rhr: 60, avg_steps: 8000, avg_vo2max: 42 },
            { week_start: "2024-01-22", avg_rhr: 65, avg_steps: 6000, avg_vo2max: 40 },
          ],
        }),
      ]);
      const repo = new HealthspanRepository(db, "user-1", "UTC");
      const result = await repo.getScore(12, "2026-03-15");
      expect(result.trend).toBe("declining");
    });

    it("returns stable trend when scores are flat", async () => {
      const db = makeDb([
        makeFullRow({
          weekly_history: [
            { week_start: "2024-01-01", avg_rhr: 55, avg_steps: 10000, avg_vo2max: 50 },
            { week_start: "2024-01-08", avg_rhr: 55, avg_steps: 10000, avg_vo2max: 50 },
            { week_start: "2024-01-15", avg_rhr: 55, avg_steps: 10000, avg_vo2max: 50 },
            { week_start: "2024-01-22", avg_rhr: 55, avg_steps: 10000, avg_vo2max: 50 },
          ],
        }),
      ]);
      const repo = new HealthspanRepository(db, "user-1", "UTC");
      const result = await repo.getScore(12, "2026-03-15");
      expect(result.trend).toBe("stable");
    });

    it("returns null trend when fewer than 4 weeks of history", async () => {
      const db = makeDb([
        makeFullRow({
          weekly_history: [
            { week_start: "2024-01-01", avg_rhr: 55, avg_steps: 10000, avg_vo2max: 50 },
            { week_start: "2024-01-08", avg_rhr: 50, avg_steps: 12000, avg_vo2max: 52 },
            { week_start: "2024-01-15", avg_rhr: 48, avg_steps: 14000, avg_vo2max: 54 },
          ],
        }),
      ]);
      const repo = new HealthspanRepository(db, "user-1", "UTC");
      const result = await repo.getScore(12, "2026-03-15");
      expect(result.trend).toBeNull();
    });

    it("returns null trend when no weekly history", async () => {
      const db = makeDb([makeFullRow({ weekly_history: null })]);
      const repo = new HealthspanRepository(db, "user-1", "UTC");
      const result = await repo.getScore(12, "2026-03-15");
      expect(result.trend).toBeNull();
    });
  });
});
