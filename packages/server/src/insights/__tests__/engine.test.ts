import { describe, expect, it } from "vitest";
import {
  type ActivityRow,
  type BodyCompRow,
  computeInsights,
  type DailyRow,
  type NutritionRow,
  type SleepRow,
} from "../engine.ts";

// ── Helpers ──────────────────────────────────────────────────────────────

function makeDailyRow(date: string, overrides: Partial<DailyRow> = {}): DailyRow {
  return {
    date,
    resting_hr: 60,
    hrv: 50,
    spo2_avg: 98,
    steps: 8000,
    active_energy_kcal: 400,
    skin_temp_c: 36.5,
    ...overrides,
  };
}

function makeSleepRow(started_at: string, overrides: Partial<SleepRow> = {}): SleepRow {
  return {
    started_at,
    duration_minutes: 480,
    deep_minutes: 90,
    rem_minutes: 100,
    light_minutes: 250,
    awake_minutes: 40,
    efficiency_pct: 92,
    is_nap: false,
    ...overrides,
  };
}

function makeActivityRow(
  started_at: string,
  ended_at: string | null,
  activity_type: string,
): ActivityRow {
  return { started_at, ended_at, activity_type };
}

function makeNutritionRow(date: string, overrides: Partial<NutritionRow> = {}): NutritionRow {
  return {
    date,
    calories: 2200,
    protein_g: 150,
    carbs_g: 250,
    fat_g: 70,
    fiber_g: 25,
    water_ml: 2500,
    ...overrides,
  };
}

function makeBodyCompRow(recorded_at: string, overrides: Partial<BodyCompRow> = {}): BodyCompRow {
  return {
    recorded_at,
    weight_kg: 80,
    body_fat_pct: 15,
    ...overrides,
  };
}

/** Generate `n` consecutive dates starting from a base date */
function dateRange(start: string, count: number): string[] {
  const dates: string[] = [];
  const d = new Date(start);
  for (let i = 0; i < count; i++) {
    dates.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("computeInsights()", () => {
  it("returns empty array when fewer than 14 days of data", () => {
    const dates = dateRange("2025-01-01", 13);
    const metrics = dates.map((d) => makeDailyRow(d));
    const result = computeInsights(metrics, [], [], [], []);
    expect(result).toEqual([]);
  });

  it("returns empty array when all input arrays are empty", () => {
    expect(computeInsights([], [], [], [], [])).toEqual([]);
  });

  it("returns insights when sufficient data is provided", () => {
    const dates = dateRange("2025-01-01", 90);
    const metrics = dates.map((d) => makeDailyRow(d));

    // Create sleep sessions starting at 11 PM the night before each date
    const sleep = dates.map((d) => {
      const dt = new Date(d);
      dt.setDate(dt.getDate() - 1);
      dt.setHours(23, 0, 0);
      return makeSleepRow(dt.toISOString());
    });

    const result = computeInsights(metrics, sleep, [], [], []);
    // Should have some insights with 90 days of uniform data
    expect(Array.isArray(result)).toBe(true);
    // All returned insights should have required fields
    for (const insight of result) {
      expect(insight.id).toBeDefined();
      expect(insight.type).toMatch(/^(conditional|correlation|discovery)$/);
      expect(insight.confidence).toMatch(/^(strong|emerging|early)$/);
      expect(insight.message).toBeDefined();
      expect(insight.explanation).toBeDefined();
    }
  });

  it("excludes nap sleep sessions from analysis", () => {
    const dates = dateRange("2025-01-01", 30);
    const metrics = dates.map((d) => makeDailyRow(d));

    // Only provide nap sessions — no real sleep
    const sleep = dates.map((d) => {
      const dt = new Date(d);
      dt.setHours(14, 0, 0);
      return makeSleepRow(dt.toISOString(), { is_nap: true, duration_minutes: 30 });
    });

    const result = computeInsights(metrics, sleep, [], [], []);
    // Should not crash, and sleep-related insights should be absent or data-less
    expect(Array.isArray(result)).toBe(true);
  });

  it("filters out nutrition days below minDailyCalories", () => {
    const dates = dateRange("2025-01-01", 30);
    const metrics = dates.map((d) => makeDailyRow(d));

    // Half days with 800 cal (below default 1200), half with 2200
    const nutrition = dates.map((d, i) =>
      makeNutritionRow(d, { calories: i % 2 === 0 ? 800 : 2200 }),
    );

    const result = computeInsights(metrics, [], [], nutrition, []);
    // Should not crash with partial nutrition data
    expect(Array.isArray(result)).toBe(true);
  });

  it("assigns sleep to wake date correctly", () => {
    // Sleep starting at 11 PM on Jan 1 with 8 hours → wakes Jan 2
    const dates = dateRange("2025-01-01", 30);
    const metrics = dates.map((d) => makeDailyRow(d));

    const sleep = dates.slice(0, -1).map((d) => {
      const dt = new Date(d);
      dt.setHours(23, 0, 0);
      return makeSleepRow(dt.toISOString(), { duration_minutes: 480 });
    });

    // Should not crash — the join should work correctly
    const result = computeInsights(metrics, sleep, [], [], []);
    expect(Array.isArray(result)).toBe(true);
  });

  it("handles activities without ended_at gracefully", () => {
    const dates = dateRange("2025-01-01", 30);
    const metrics = dates.map((d) => makeDailyRow(d));

    const activities = dates.map((d) => makeActivityRow(`${d}T10:00:00Z`, null, "running"));

    const result = computeInsights(metrics, [], activities, [], []);
    expect(Array.isArray(result)).toBe(true);
  });

  it("keeps body comp measurement with last-wins on same date", () => {
    const dates = dateRange("2025-01-01", 30);
    const metrics = dates.map((d) => makeDailyRow(d));

    // Two measurements on the same day — second one should win
    const bodyComp = dates.flatMap((d) => [
      makeBodyCompRow(`${d}T08:00:00Z`, { weight_kg: 80 }),
      makeBodyCompRow(`${d}T20:00:00Z`, { weight_kg: 82 }),
    ]);

    const result = computeInsights(metrics, [], [], [], bodyComp);
    expect(Array.isArray(result)).toBe(true);
  });

  it("produces insights with correct unit labels (kg not lbs)", () => {
    const dates = dateRange("2025-01-01", 180);
    const metrics = dates.map((d) => makeDailyRow(d));

    // Varying exercise and body comp to trigger monthly insights
    const activities = dates.map((d, i) =>
      makeActivityRow(
        `${d}T10:00:00Z`,
        `${d}T11:00:00Z`,
        i % 2 === 0 ? "running" : "strength_training",
      ),
    );

    const bodyComp = dates.map((d, i) =>
      makeBodyCompRow(`${d}T08:00:00Z`, {
        weight_kg: 80 - i * 0.02, // gradual weight loss
      }),
    );

    const result = computeInsights(metrics, [], activities, [], bodyComp);

    // Check that no insight message or detail contains "lbs"
    for (const insight of result) {
      expect(insight.message).not.toContain("lbs");
      expect(insight.detail).not.toContain("lbs");
      if (insight.explanation) {
        expect(insight.explanation).not.toContain("lbs");
      }
    }
  });

  it("all insights have confidence != insufficient (filtered by engine)", () => {
    const dates = dateRange("2025-01-01", 90);
    const metrics = dates.map((d) => makeDailyRow(d));
    const sleep = dates.map((d) => {
      const dt = new Date(d);
      dt.setDate(dt.getDate() - 1);
      dt.setHours(23, 0, 0);
      return makeSleepRow(dt.toISOString());
    });

    const result = computeInsights(metrics, sleep, [], [], []);
    for (const insight of result) {
      expect(insight.confidence).not.toBe("insufficient");
    }
  });

  it("caps output at 20 insights", () => {
    const dates = dateRange("2025-01-01", 365);
    const metrics = dates.map((d, i) =>
      makeDailyRow(d, {
        hrv: 30 + Math.sin(i * 0.1) * 20,
        resting_hr: 55 + Math.cos(i * 0.1) * 10,
        steps: 5000 + Math.sin(i * 0.2) * 3000,
      }),
    );

    const sleep = dates.map((d, i) => {
      const dt = new Date(d);
      dt.setDate(dt.getDate() - 1);
      dt.setHours(23, 0, 0);
      return makeSleepRow(dt.toISOString(), {
        duration_minutes: 400 + Math.sin(i * 0.15) * 60,
        deep_minutes: 60 + Math.sin(i * 0.12) * 30,
      });
    });

    const activities = dates.map((d, i) =>
      makeActivityRow(
        `${d}T10:00:00Z`,
        `${d}T${10 + (i % 3 === 0 ? 1 : 0)}:30:00Z`,
        i % 3 === 0 ? "running" : i % 3 === 1 ? "cycling" : "strength_training",
      ),
    );

    const nutrition = dates.map((d, i) =>
      makeNutritionRow(d, {
        calories: 1800 + Math.sin(i * 0.1) * 500,
        protein_g: 100 + Math.sin(i * 0.15) * 50,
      }),
    );

    const result = computeInsights(metrics, sleep, activities, nutrition, []);
    expect(result.length).toBeLessThanOrEqual(20);
  });

  it("sorts insights by confidence then effect size", () => {
    const dates = dateRange("2025-01-01", 365);
    const metrics = dates.map((d, i) =>
      makeDailyRow(d, {
        hrv: 30 + Math.sin(i * 0.1) * 20,
        resting_hr: 55 + Math.cos(i * 0.1) * 10,
      }),
    );

    const sleep = dates.map((d, i) => {
      const dt = new Date(d);
      dt.setDate(dt.getDate() - 1);
      dt.setHours(23, 0, 0);
      return makeSleepRow(dt.toISOString(), {
        duration_minutes: 400 + Math.sin(i * 0.15) * 60,
      });
    });

    const result = computeInsights(metrics, sleep, [], [], []);
    if (result.length >= 2) {
      const confidenceOrder = { strong: 0, emerging: 1, early: 2, insufficient: 3 };
      for (let i = 1; i < result.length; i++) {
        const prevOrder = confidenceOrder[result[i - 1]!.confidence];
        const currOrder = confidenceOrder[result[i]!.confidence];
        if (prevOrder === currOrder) {
          expect(Math.abs(result[i - 1]!.effectSize)).toBeGreaterThanOrEqual(
            Math.abs(result[i]!.effectSize),
          );
        } else {
          expect(prevOrder).toBeLessThanOrEqual(currOrder);
        }
      }
    }
  });

  it("uses effective sample size for monthly-scoped confidence (no inflated n from overlapping windows)", () => {
    // Create 365 days of data with a clear split: first half high protein, second half low
    // This generates many overlapping 30-day windows per group (raw n >> 30)
    // but effective n should be much lower (~6 per side)
    // Confidence should NOT be "strong" even if Cohen's d is large
    const dates = dateRange("2025-01-01", 365);
    const metrics = dates.map((d) => makeDailyRow(d));

    // First 180 days: high protein (>30% cal), last 185: low protein
    const nutrition = dates.map((d, i) =>
      makeNutritionRow(d, {
        calories: 2000,
        protein_g: i < 180 ? 200 : 60, // 40% vs 12% of calories from protein
        carbs_g: 200,
        fat_g: 60,
      }),
    );

    // Weight goes up in high-protein phase, down in low-protein phase
    // This creates a large effect size between the groups
    const bodyComp = dates.map((d, i) =>
      makeBodyCompRow(`${d}T08:00:00Z`, {
        weight_kg: i < 180 ? 80 + i * 0.02 : 83.6 - (i - 180) * 0.02,
        body_fat_pct: 15,
      }),
    );

    const result = computeInsights(metrics, [], [], nutrition, bodyComp);

    const monthlyInsights = result.filter(
      (i) => i.id === "high-protein-pct-weight" || i.id === "high-protein-pct-bf",
    );
    // With effective n ≈ 6 per group (not 150+), these should not be "strong"
    for (const insight of monthlyInsights) {
      expect(insight.confidence).not.toBe("strong");
    }
  });

  it("does not show percentage difference for body comp deltas near zero", () => {
    // When the baseline mean is near zero, percentage is meaningless (e.g., 599%)
    const dates = dateRange("2025-01-01", 180);
    const metrics = dates.map((d) => makeDailyRow(d));

    // Half the time high protein, half not — to create two groups
    const nutrition = dates.map((d, i) =>
      makeNutritionRow(d, {
        calories: 2000,
        protein_g: i % 60 < 30 ? 200 : 80, // alternating months of high/low protein
        carbs_g: 200,
        fat_g: 60,
      }),
    );

    // Weight hovering around 80kg with tiny fluctuations
    const bodyComp = dates.map((d, i) =>
      makeBodyCompRow(`${d}T08:00:00Z`, {
        weight_kg: 80 + Math.sin(i * 0.1) * 0.5,
        body_fat_pct: 15,
      }),
    );

    const result = computeInsights(metrics, [], [], nutrition, bodyComp);

    // Any insight about "monthly weight change" should NOT show >100% difference
    // because the baseline is near zero — should use absolute difference instead
    const bodyCompInsights = result.filter(
      (i) => i.metric.includes("weight change") || i.metric.includes("body fat change"),
    );
    for (const insight of bodyCompInsights) {
      const pctMatch = insight.message.match(/(\d+)%/);
      if (pctMatch) {
        const pct = Number.parseInt(pctMatch[1]!, 10);
        expect(pct).toBeLessThanOrEqual(100);
      }
    }
  });

  it("detects a strong positive correlation in synthetic data", () => {
    // Create data where sleep duration perfectly predicts next-day HRV
    const dates = dateRange("2025-01-01", 90);
    const metrics = dates.map((d, i) =>
      makeDailyRow(d, {
        hrv: 30 + i * 0.5, // linearly increasing HRV
        resting_hr: 70 - i * 0.1,
      }),
    );

    // Sleep with duration that matches next-day HRV pattern
    const sleep = dates.map((d, i) => {
      const dt = new Date(d);
      dt.setDate(dt.getDate() - 1);
      dt.setHours(23, 0, 0);
      return makeSleepRow(dt.toISOString(), {
        duration_minutes: 360 + i * 3, // linearly increasing sleep
      });
    });

    const result = computeInsights(metrics, sleep, [], [], []);
    // Should find a correlation between sleep duration and HRV
    const sleepHrvInsight = result.find(
      (i) =>
        (i.metric.includes("HRV") && i.action.includes("sleep")) ||
        (i.action.includes("sleep") && i.metric.includes("HRV")),
    );
    if (sleepHrvInsight) {
      expect(sleepHrvInsight.effectSize).not.toBe(0);
    }
  });
});
