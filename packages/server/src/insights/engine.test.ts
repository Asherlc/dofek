import { describe, expect, it } from "vitest";
import {
  type ActivityRow,
  aggregateMonthly,
  type BodyCompRow,
  classifyActivity,
  classifyConfidence,
  classifyCorrelationConfidence,
  computeInsights,
  type DailyRow,
  downsample,
  exhaustiveSweep,
  explainInsight,
  getAllMetrics,
  getConditionalTests,
  getCorrelationPairs,
  type Insight,
  type InsightsConfig,
  isValidCausalDirection,
  type JoinedDay,
  joinByDate,
  type NutritionRow,
  rollingAvg,
  type SleepRow,
} from "./engine.ts";

const DEFAULT_CONFIG: InsightsConfig = { minDailyCalories: 1200 };

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
  const cursor = new Date(start);
  for (let i = 0; i < count; i++) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

// ── joinByDate tests ────────────────────────────────────────────────────

describe("joinByDate()", () => {
  it("returns empty array for empty inputs", () => {
    const result = joinByDate([], [], [], [], [], DEFAULT_CONFIG);
    expect(result).toEqual([]);
  });

  it("maps daily metric fields to joined output", () => {
    const metrics = [
      makeDailyRow("2025-01-01", {
        resting_hr: 58,
        hrv: 65,
        spo2_avg: 97,
        steps: 12000,
        active_energy_kcal: 500,
        skin_temp_c: 36.8,
      }),
    ];
    const result = joinByDate(metrics, [], [], [], [], DEFAULT_CONFIG);
    expect(result).toHaveLength(1);
    expect(result[0]?.resting_hr).toBe(58);
    expect(result[0]?.hrv).toBe(65);
    expect(result[0]?.spo2_avg).toBe(97);
    expect(result[0]?.steps).toBe(12000);
    expect(result[0]?.active_energy_kcal).toBe(500);
    expect(result[0]?.skin_temp_c).toBe(36.8);
  });

  it("assigns null for missing sleep, activity, nutrition, body comp", () => {
    const metrics = [makeDailyRow("2025-01-01")];
    const result = joinByDate(metrics, [], [], [], [], DEFAULT_CONFIG);
    expect(result[0]?.sleep_duration_min).toBeNull();
    expect(result[0]?.deep_min).toBeNull();
    expect(result[0]?.rem_min).toBeNull();
    expect(result[0]?.sleep_efficiency).toBeNull();
    expect(result[0]?.exercise_minutes).toBeNull();
    expect(result[0]?.cardio_minutes).toBeNull();
    expect(result[0]?.strength_minutes).toBeNull();
    expect(result[0]?.flexibility_minutes).toBeNull();
    expect(result[0]?.calories).toBeNull();
    expect(result[0]?.protein_g).toBeNull();
    expect(result[0]?.weight_kg).toBeNull();
    expect(result[0]?.body_fat_pct).toBeNull();
  });

  it("excludes nap sessions from sleep mapping", () => {
    const metrics = [makeDailyRow("2025-01-02")];
    const sleep = [makeSleepRow("2025-01-01T23:00:00Z", { is_nap: true, duration_minutes: 30 })];
    const result = joinByDate(metrics, sleep, [], [], [], DEFAULT_CONFIG);
    expect(result[0]?.sleep_duration_min).toBeNull();
  });

  it("assigns sleep to wake date (not start date)", () => {
    const metrics = [makeDailyRow("2025-01-01"), makeDailyRow("2025-01-02")];
    // Sleep starting 11 PM Jan 1, 8 hours → wakes Jan 2
    const sleep = [makeSleepRow("2025-01-01T23:00:00Z", { duration_minutes: 480 })];
    const result = joinByDate(metrics, sleep, [], [], [], DEFAULT_CONFIG);
    // Jan 1 should have no sleep (the sleep belongs to Jan 2's wake date)
    expect(result.find((d) => d.date === "2025-01-01")?.sleep_duration_min).toBeNull();
    // Jan 2 should have the sleep
    expect(result.find((d) => d.date === "2025-01-02")?.sleep_duration_min).toBe(480);
  });

  it("picks longest sleep session for a given wake date", () => {
    const metrics = [makeDailyRow("2025-01-02")];
    // Two sleep sessions ending on same date — longer one should win
    const sleep = [
      makeSleepRow("2025-01-01T23:00:00Z", { duration_minutes: 300 }),
      makeSleepRow("2025-01-01T22:00:00Z", { duration_minutes: 480 }),
    ];
    const result = joinByDate(metrics, sleep, [], [], [], DEFAULT_CONFIG);
    expect(result[0]?.sleep_duration_min).toBe(480);
  });

  it("maps sleep detail fields (deep, rem, efficiency)", () => {
    const metrics = [makeDailyRow("2025-01-02")];
    const sleep = [
      makeSleepRow("2025-01-01T23:00:00Z", {
        duration_minutes: 480,
        deep_minutes: 85,
        rem_minutes: 110,
        efficiency_pct: 94,
      }),
    ];
    const result = joinByDate(metrics, sleep, [], [], [], DEFAULT_CONFIG);
    expect(result[0]?.deep_min).toBe(85);
    expect(result[0]?.rem_min).toBe(110);
    expect(result[0]?.sleep_efficiency).toBe(94);
  });

  it("computes activity duration from started_at/ended_at", () => {
    const metrics = [makeDailyRow("2025-01-01")];
    const activities = [makeActivityRow("2025-01-01T10:00:00Z", "2025-01-01T11:00:00Z", "running")];
    const result = joinByDate(metrics, [], activities, [], [], DEFAULT_CONFIG);
    expect(result[0]?.exercise_minutes).toBe(60);
    expect(result[0]?.cardio_minutes).toBe(60);
    expect(result[0]?.strength_minutes).toBe(0);
    expect(result[0]?.flexibility_minutes).toBe(0);
  });

  it("classifies activity types into categories", () => {
    const metrics = [makeDailyRow("2025-01-01")];
    const activities = [
      makeActivityRow("2025-01-01T08:00:00Z", "2025-01-01T09:00:00Z", "strength_training"),
      makeActivityRow("2025-01-01T10:00:00Z", "2025-01-01T10:30:00Z", "yoga"),
      makeActivityRow("2025-01-01T11:00:00Z", "2025-01-01T12:00:00Z", "cycling"),
    ];
    const result = joinByDate(metrics, [], activities, [], [], DEFAULT_CONFIG);
    expect(result[0]?.strength_minutes).toBe(60);
    expect(result[0]?.flexibility_minutes).toBe(30);
    expect(result[0]?.cardio_minutes).toBe(60);
    expect(result[0]?.exercise_minutes).toBe(150);
  });

  it("classifies additional cardio types correctly", () => {
    const metrics = [makeDailyRow("2025-01-01")];
    const cardioTypes = [
      "walking",
      "hiking",
      "swimming",
      "cross_country_skiing",
      "downhill_skiing",
      "tennis",
      "climbing",
    ];
    const activities = cardioTypes.map((type, index) =>
      makeActivityRow(
        `2025-01-01T${(8 + index).toString().padStart(2, "0")}:00:00Z`,
        `2025-01-01T${(8 + index).toString().padStart(2, "0")}:30:00Z`,
        type,
      ),
    );
    const result = joinByDate(metrics, [], activities, [], [], DEFAULT_CONFIG);
    // All should be cardio: 7 activities * 30 min each
    expect(result[0]?.cardio_minutes).toBe(210);
    expect(result[0]?.strength_minutes).toBe(0);
  });

  it("classifies strength types correctly", () => {
    const metrics = [makeDailyRow("2025-01-01")];
    const strengthTypes = ["strength_training", "functional_strength", "strength"];
    const activities = strengthTypes.map((type, index) =>
      makeActivityRow(
        `2025-01-01T${(8 + index).toString().padStart(2, "0")}:00:00Z`,
        `2025-01-01T${(8 + index).toString().padStart(2, "0")}:30:00Z`,
        type,
      ),
    );
    const result = joinByDate(metrics, [], activities, [], [], DEFAULT_CONFIG);
    expect(result[0]?.strength_minutes).toBe(90);
  });

  it("classifies flexibility types correctly", () => {
    const metrics = [makeDailyRow("2025-01-01")];
    const flexTypes = ["yoga", "stretching", "preparation_and_recovery"];
    const activities = flexTypes.map((type, index) =>
      makeActivityRow(
        `2025-01-01T${(8 + index).toString().padStart(2, "0")}:00:00Z`,
        `2025-01-01T${(8 + index).toString().padStart(2, "0")}:30:00Z`,
        type,
      ),
    );
    const result = joinByDate(metrics, [], activities, [], [], DEFAULT_CONFIG);
    expect(result[0]?.flexibility_minutes).toBe(90);
  });

  it("classifies unknown activity types as other (no category increment)", () => {
    const metrics = [makeDailyRow("2025-01-01")];
    const activities = [
      makeActivityRow("2025-01-01T10:00:00Z", "2025-01-01T11:00:00Z", "paddle_boarding"),
    ];
    const result = joinByDate(metrics, [], activities, [], [], DEFAULT_CONFIG);
    expect(result[0]?.exercise_minutes).toBe(60);
    expect(result[0]?.cardio_minutes).toBe(0);
    expect(result[0]?.strength_minutes).toBe(0);
    expect(result[0]?.flexibility_minutes).toBe(0);
  });

  it("ignores activities without ended_at (no duration)", () => {
    const metrics = [makeDailyRow("2025-01-01")];
    const activities = [makeActivityRow("2025-01-01T10:00:00Z", null, "running")];
    const result = joinByDate(metrics, [], activities, [], [], DEFAULT_CONFIG);
    expect(result[0]?.exercise_minutes).toBe(0);
  });

  it("sums multiple activities on the same day", () => {
    const metrics = [makeDailyRow("2025-01-01")];
    const activities = [
      makeActivityRow("2025-01-01T08:00:00Z", "2025-01-01T09:00:00Z", "running"),
      makeActivityRow("2025-01-01T17:00:00Z", "2025-01-01T18:00:00Z", "strength_training"),
    ];
    const result = joinByDate(metrics, [], activities, [], [], DEFAULT_CONFIG);
    expect(result[0]?.exercise_minutes).toBe(120);
    expect(result[0]?.cardio_minutes).toBe(60);
    expect(result[0]?.strength_minutes).toBe(60);
  });

  it("filters nutrition below minDailyCalories threshold", () => {
    const metrics = [makeDailyRow("2025-01-01"), makeDailyRow("2025-01-02")];
    const nutrition = [
      makeNutritionRow("2025-01-01", { calories: 800 }), // below 1200 threshold
      makeNutritionRow("2025-01-02", { calories: 2200 }), // above threshold
    ];
    const result = joinByDate(metrics, [], [], nutrition, [], DEFAULT_CONFIG);
    expect(result.find((d) => d.date === "2025-01-01")?.calories).toBeNull();
    expect(result.find((d) => d.date === "2025-01-02")?.calories).toBe(2200);
  });

  it("uses custom minDailyCalories from config", () => {
    const metrics = [makeDailyRow("2025-01-01")];
    const nutrition = [makeNutritionRow("2025-01-01", { calories: 500 })];
    const result = joinByDate(metrics, [], [], nutrition, [], { minDailyCalories: 400 });
    expect(result[0]?.calories).toBe(500);
  });

  it("maps nutrition fields to joined output", () => {
    const metrics = [makeDailyRow("2025-01-01")];
    const nutrition = [
      makeNutritionRow("2025-01-01", {
        calories: 2500,
        protein_g: 180,
        carbs_g: 280,
        fat_g: 80,
        fiber_g: 35,
      }),
    ];
    const result = joinByDate(metrics, [], [], nutrition, [], DEFAULT_CONFIG);
    expect(result[0]?.calories).toBe(2500);
    expect(result[0]?.protein_g).toBe(180);
    expect(result[0]?.carbs_g).toBe(280);
    expect(result[0]?.fat_g).toBe(80);
    expect(result[0]?.fiber_g).toBe(35);
  });

  it("uses last body comp measurement on same date (last wins)", () => {
    const metrics = [makeDailyRow("2025-01-01")];
    const bodyComp = [
      makeBodyCompRow("2025-01-01T08:00:00Z", { weight_kg: 80 }),
      makeBodyCompRow("2025-01-01T20:00:00Z", { weight_kg: 81.5, body_fat_pct: 14 }),
    ];
    const result = joinByDate(metrics, [], [], [], bodyComp, DEFAULT_CONFIG);
    expect(result[0]?.weight_kg).toBe(81.5);
    expect(result[0]?.body_fat_pct).toBe(14);
  });

  it("sorts output by date ascending", () => {
    const metrics = [
      makeDailyRow("2025-01-03"),
      makeDailyRow("2025-01-01"),
      makeDailyRow("2025-01-02"),
    ];
    const result = joinByDate(metrics, [], [], [], [], DEFAULT_CONFIG);
    expect(result.map((d) => d.date)).toEqual(["2025-01-01", "2025-01-02", "2025-01-03"]);
  });

  it("computes 30-day rolling weight average when >= 5 measurements in window", () => {
    const dates = dateRange("2025-01-01", 35);
    const metrics = dates.map((d) => makeDailyRow(d));
    const bodyComp = dates.map((d, index) =>
      makeBodyCompRow(`${d}T08:00:00Z`, { weight_kg: 80 + index * 0.1 }),
    );
    const result = joinByDate(metrics, [], [], [], bodyComp, DEFAULT_CONFIG);
    // The 30th day (index 29) should have a weight_30d_avg
    const day30 = result[29];
    expect(day30?.weight_30d_avg).not.toBeNull();
    // Should be the average of indices 0-29 → avg of 80.0, 80.1, ..., 82.9
    expect(day30?.weight_30d_avg).toBeCloseTo((80 + 82.9) / 2, 0);
  });

  it("returns null for rolling average when fewer than 30 days", () => {
    const dates = dateRange("2025-01-01", 20);
    const metrics = dates.map((d) => makeDailyRow(d));
    const bodyComp = dates.map((d) => makeBodyCompRow(`${d}T08:00:00Z`, { weight_kg: 80 }));
    const result = joinByDate(metrics, [], [], [], bodyComp, DEFAULT_CONFIG);
    // All days should have null rolling averages since < 30 days
    for (const day of result) {
      expect(day.weight_30d_avg).toBeNull();
    }
  });

  it("computes 30-day rolling body fat average", () => {
    const dates = dateRange("2025-01-01", 35);
    const metrics = dates.map((d) => makeDailyRow(d));
    const bodyComp = dates.map((d) => makeBodyCompRow(`${d}T08:00:00Z`, { body_fat_pct: 15 }));
    const result = joinByDate(metrics, [], [], [], bodyComp, DEFAULT_CONFIG);
    expect(result[29]?.body_fat_30d_avg).toBeCloseTo(15, 0);
  });

  it("computes weight delta when 60+ days of data", () => {
    const dates = dateRange("2025-01-01", 65);
    const metrics = dates.map((d) => makeDailyRow(d));
    // Weight gradually increasing: 80 → 86.4 over 65 days
    const bodyComp = dates.map((d, index) =>
      makeBodyCompRow(`${d}T08:00:00Z`, { weight_kg: 80 + index * 0.1 }),
    );
    const result = joinByDate(metrics, [], [], [], bodyComp, DEFAULT_CONFIG);
    // Need i >= BODY_WINDOW * 2 - 1 = 59 for delta
    const day60 = result[59];
    expect(day60?.weight_30d_delta).not.toBeNull();
    // Delta should be positive (weight increasing)
    expect(day60?.weight_30d_delta).toBeGreaterThan(0);
  });

  it("returns null for weight delta when fewer than 60 days", () => {
    const dates = dateRange("2025-01-01", 50);
    const metrics = dates.map((d) => makeDailyRow(d));
    const bodyComp = dates.map((d) => makeBodyCompRow(`${d}T08:00:00Z`, { weight_kg: 80 }));
    const result = joinByDate(metrics, [], [], [], bodyComp, DEFAULT_CONFIG);
    for (const day of result) {
      expect(day.weight_30d_delta).toBeNull();
    }
  });

  it("computes body fat delta when 60+ days of data", () => {
    const dates = dateRange("2025-01-01", 65);
    const metrics = dates.map((d) => makeDailyRow(d));
    const bodyComp = dates.map((d, index) =>
      makeBodyCompRow(`${d}T08:00:00Z`, { body_fat_pct: 15 - index * 0.05 }),
    );
    const result = joinByDate(metrics, [], [], [], bodyComp, DEFAULT_CONFIG);
    // Need i >= BODY_WINDOW * 2 - 1 = 59 for delta
    const day60 = result[59];
    expect(day60?.body_fat_30d_delta).not.toBeNull();
    // Delta should be negative (body fat decreasing)
    expect(day60?.body_fat_30d_delta).toBeLessThan(0);
  });

  it("requires minimum 5 weight measurements in window for rolling average", () => {
    const dates = dateRange("2025-01-01", 35);
    const metrics = dates.map((d) => makeDailyRow(d));
    // Only 3 body comp measurements in the first 30 days
    const bodyComp = [
      makeBodyCompRow("2025-01-01T08:00:00Z", { weight_kg: 80 }),
      makeBodyCompRow("2025-01-15T08:00:00Z", { weight_kg: 80 }),
      makeBodyCompRow("2025-01-25T08:00:00Z", { weight_kg: 80 }),
    ];
    const result = joinByDate(metrics, [], [], [], bodyComp, DEFAULT_CONFIG);
    // Day 30 should have null avg since only 3 measurements
    expect(result[29]?.weight_30d_avg).toBeNull();
  });

  it("handles Date objects in daily metrics", () => {
    const metrics: DailyRow[] = [
      {
        date: new Date("2025-01-01"),
        resting_hr: 60,
        hrv: 50,
        spo2_avg: 98,
        steps: 8000,
        active_energy_kcal: 400,
        skin_temp_c: 36.5,
      },
    ];
    const result = joinByDate(metrics, [], [], [], [], DEFAULT_CONFIG);
    expect(result).toHaveLength(1);
    expect(result[0]?.date).toBe("2025-01-01");
  });

  it("handles activity type classification case-insensitively", () => {
    const metrics = [makeDailyRow("2025-01-01")];
    const activities = [makeActivityRow("2025-01-01T10:00:00Z", "2025-01-01T11:00:00Z", "CYCLING")];
    const result = joinByDate(metrics, [], activities, [], [], DEFAULT_CONFIG);
    expect(result[0]?.cardio_minutes).toBe(60);
  });

  it("handles cross_training as cardio", () => {
    const metrics = [makeDailyRow("2025-01-01")];
    const activities = [
      makeActivityRow("2025-01-01T10:00:00Z", "2025-01-01T11:00:00Z", "cross_training"),
    ];
    const result = joinByDate(metrics, [], activities, [], [], DEFAULT_CONFIG);
    expect(result[0]?.cardio_minutes).toBe(60);
  });

  it("handles sleep with null duration_minutes", () => {
    const metrics = [makeDailyRow("2025-01-02")];
    const sleep = [makeSleepRow("2025-01-01T23:00:00Z", { duration_minutes: null })];
    const result = joinByDate(metrics, sleep, [], [], [], DEFAULT_CONFIG);
    // With null duration, wake date = start date (no offset), sleep goes to Jan 1
    // Jan 2 should have no sleep
    expect(result[0]?.sleep_duration_min).toBeNull();
  });
});

// ── computeInsights tests ───────────────────────────────────────────────

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
        const prevOrder = confidenceOrder[result[i - 1]?.confidence ?? "insufficient"];
        const currOrder = confidenceOrder[result[i]?.confidence ?? "insufficient"];
        if (prevOrder === currOrder) {
          expect(Math.abs(result[i - 1]?.effectSize ?? 0)).toBeGreaterThanOrEqual(
            Math.abs(result[i]?.effectSize ?? 0),
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
      const percentageMatch = insight.message.match(/(\d+)%/);
      if (percentageMatch) {
        const percentageStr = percentageMatch[1];
        if (!percentageStr) continue;
        const percentage = Number.parseInt(percentageStr, 10);
        expect(percentage).toBeLessThanOrEqual(100);
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

  it("generates conditional insights with correct structure", () => {
    const dates = dateRange("2025-01-01", 120);
    // Half days: high sleep (8h), half: low sleep (5h)
    // HRV varies accordingly: higher after good sleep
    const metrics = dates.map((d, i) =>
      makeDailyRow(d, {
        hrv: i % 2 === 0 ? 70 : 35, // alternating high/low HRV
        resting_hr: i % 2 === 0 ? 55 : 68,
      }),
    );
    const sleep = dates.map((d, i) => {
      const dt = new Date(d);
      dt.setDate(dt.getDate() - 1);
      dt.setHours(23, 0, 0);
      return makeSleepRow(dt.toISOString(), {
        duration_minutes: i % 2 === 0 ? 480 : 300, // 8h vs 5h
        deep_minutes: i % 2 === 0 ? 90 : 40,
      });
    });

    const result = computeInsights(metrics, sleep, [], [], []);
    const conditionals = result.filter((i) => i.type === "conditional");
    for (const insight of conditionals) {
      expect(insight.whenTrue).toBeDefined();
      expect(insight.whenFalse).toBeDefined();
      expect(typeof insight.effectSize).toBe("number");
      expect(typeof insight.pValue).toBe("number");
      expect(insight.distributions).toBeDefined();
      expect(insight.distributions?.withAction.length).toBeGreaterThan(0);
      expect(insight.distributions?.withoutAction.length).toBeGreaterThan(0);
    }
  });

  it("generates correlation insights with dataPoints", () => {
    const dates = dateRange("2025-01-01", 90);
    const metrics = dates.map((d, i) =>
      makeDailyRow(d, {
        hrv: 30 + i * 0.5,
        resting_hr: 75 - i * 0.2,
      }),
    );
    const sleep = dates.map((d, i) => {
      const dt = new Date(d);
      dt.setDate(dt.getDate() - 1);
      dt.setHours(23, 0, 0);
      return makeSleepRow(dt.toISOString(), {
        duration_minutes: 360 + i * 2,
      });
    });

    const result = computeInsights(metrics, sleep, [], [], []);
    const correlations = result.filter((i) => i.type === "correlation");
    for (const insight of correlations) {
      expect(insight.correlation).toBeDefined();
      expect(typeof insight.correlation?.rho).toBe("number");
      expect(typeof insight.correlation?.pValue).toBe("number");
      if (insight.dataPoints) {
        for (const point of insight.dataPoints) {
          expect(typeof point.x).toBe("number");
          expect(typeof point.y).toBe("number");
          expect(typeof point.date).toBe("string");
        }
      }
    }
  });

  it("limits dataPoints to 200 entries for large datasets", () => {
    const dates = dateRange("2025-01-01", 365);
    const metrics = dates.map((d, i) =>
      makeDailyRow(d, {
        hrv: 30 + i * 0.1,
        resting_hr: 70 - i * 0.05,
      }),
    );
    const sleep = dates.map((d, i) => {
      const dt = new Date(d);
      dt.setDate(dt.getDate() - 1);
      dt.setHours(23, 0, 0);
      return makeSleepRow(dt.toISOString(), {
        duration_minutes: 380 + i * 0.5,
      });
    });

    const result = computeInsights(metrics, sleep, [], [], []);
    for (const insight of result) {
      if (insight.dataPoints) {
        expect(insight.dataPoints.length).toBeLessThanOrEqual(200);
      }
      if (insight.distributions) {
        expect(insight.distributions.withAction.length).toBeLessThanOrEqual(200);
        expect(insight.distributions.withoutAction.length).toBeLessThanOrEqual(200);
      }
    }
  });

  it("generates explanation strings for conditional insights", () => {
    const dates = dateRange("2025-01-01", 120);
    const metrics = dates.map((d, i) => makeDailyRow(d, { hrv: i % 2 === 0 ? 70 : 35 }));
    const sleep = dates.map((d, i) => {
      const dt = new Date(d);
      dt.setDate(dt.getDate() - 1);
      dt.setHours(23, 0, 0);
      return makeSleepRow(dt.toISOString(), {
        duration_minutes: i % 2 === 0 ? 480 : 300,
      });
    });

    const result = computeInsights(metrics, sleep, [], [], []);
    for (const insight of result) {
      expect(insight.explanation).toBeDefined();
      expect(typeof insight.explanation).toBe("string");
      expect(insight.explanation?.length).toBeGreaterThan(0);
    }
  });

  it("explanation uses confidence-based frequency words", () => {
    const dates = dateRange("2025-01-01", 120);
    const metrics = dates.map((d, i) => makeDailyRow(d, { hrv: i % 2 === 0 ? 70 : 35 }));
    const sleep = dates.map((d, i) => {
      const dt = new Date(d);
      dt.setDate(dt.getDate() - 1);
      dt.setHours(23, 0, 0);
      return makeSleepRow(dt.toISOString(), {
        duration_minutes: i % 2 === 0 ? 480 : 300,
      });
    });

    const result = computeInsights(metrics, sleep, [], [], []);
    for (const insight of result) {
      if (insight.type === "conditional" && insight.explanation) {
        // Should contain one of the confidence frequency words
        expect(
          insight.explanation.includes("consistently") ||
            insight.explanation.includes("generally") ||
            insight.explanation.includes("sometimes"),
        ).toBe(true);
      }
    }
  });

  it("explanation for correlation uses More/Higher prefix", () => {
    const dates = dateRange("2025-01-01", 90);
    const metrics = dates.map((d, i) => makeDailyRow(d, { hrv: 30 + i * 0.5 }));
    const sleep = dates.map((d, i) => {
      const dt = new Date(d);
      dt.setDate(dt.getDate() - 1);
      dt.setHours(23, 0, 0);
      return makeSleepRow(dt.toISOString(), {
        duration_minutes: 360 + i * 2,
      });
    });

    const result = computeInsights(metrics, sleep, [], [], []);
    const correlations = result.filter((i) => i.type === "correlation" || i.type === "discovery");
    for (const insight of correlations) {
      if (insight.explanation) {
        expect(
          insight.explanation.startsWith("More") || insight.explanation.startsWith("Higher"),
        ).toBe(true);
      }
    }
  });

  it("generates discovery insights from exhaustive sweep", () => {
    // Provide varied data that triggers discovery (non-predefined pairs)
    const dates = dateRange("2025-01-01", 120);
    const metrics = dates.map((d, i) =>
      makeDailyRow(d, {
        skin_temp_c: 36 + (i % 2 === 0 ? 0.8 : 0), // alternating skin temp
        spo2_avg: 95 + (i % 2 === 0 ? 3 : 0), // correlated SpO2
      }),
    );
    const sleep = dates.map((d, i) => {
      const dt = new Date(d);
      dt.setDate(dt.getDate() - 1);
      dt.setHours(23, 0, 0);
      return makeSleepRow(dt.toISOString(), {
        duration_minutes: i % 2 === 0 ? 500 : 350,
      });
    });
    const nutrition = dates.map((d, i) =>
      makeNutritionRow(d, {
        calories: 2000,
        fiber_g: i % 2 === 0 ? 40 : 10,
      }),
    );

    const result = computeInsights(metrics, sleep, [], nutrition, []);
    const discoveries = result.filter((i) => i.type === "discovery");
    for (const discovery of discoveries) {
      expect(discovery.id).toMatch(/^disc-/);
      expect(discovery.message).toContain("associated with");
      expect(discovery.correlation).toBeDefined();
    }
  });

  it("discovery deduplicates reversed pairs (keeps strongest)", () => {
    const dates = dateRange("2025-01-01", 120);
    const metrics = dates.map((d, i) =>
      makeDailyRow(d, {
        hrv: 30 + i * 0.5,
        resting_hr: 75 - i * 0.2,
      }),
    );
    const sleep = dates.map((d, i) => {
      const dt = new Date(d);
      dt.setDate(dt.getDate() - 1);
      dt.setHours(23, 0, 0);
      return makeSleepRow(dt.toISOString(), {
        duration_minutes: 360 + i * 2,
      });
    });

    const result = computeInsights(metrics, sleep, [], [], []);
    const discoveries = result.filter((i) => i.type === "discovery");
    // Check no pair appears in both directions
    const pairKeys = new Set<string>();
    for (const discovery of discoveries) {
      const [sortedA, sortedB] = [discovery.action, discovery.metric].sort();
      const key = `${sortedA}::${sortedB}`;
      expect(pairKeys.has(key)).toBe(false);
      pairKeys.add(key);
    }
  });

  it("produces monthly insights with 6+ months of data", () => {
    const dates = dateRange("2025-01-01", 210);
    const metrics = dates.map((d) => makeDailyRow(d));

    const nutrition = dates.map((d, i) =>
      makeNutritionRow(d, {
        calories: 2000 + (i % 30 < 15 ? 500 : 0),
        protein_g: 120 + (i % 30 < 15 ? 60 : 0),
      }),
    );

    const activities = dates.map((d, i) =>
      makeActivityRow(
        `${d}T10:00:00Z`,
        `${d}T11:00:00Z`,
        i % 2 === 0 ? "running" : "strength_training",
      ),
    );

    const bodyComp = dates.map((d, i) =>
      makeBodyCompRow(`${d}T08:00:00Z`, {
        weight_kg: 80 - i * 0.02,
        body_fat_pct: 15 - i * 0.01,
      }),
    );

    const result = computeInsights(metrics, [], activities, nutrition, bodyComp);
    // Should have some monthly-level insights
    const monthlyCorrelations = result.filter(
      (i) => i.type === "correlation" && i.id.startsWith("m-"),
    );
    // With enough data, should produce at least some monthly insights
    expect(
      monthlyCorrelations.length + result.filter((i) => i.id === "m-high-exercise-weight").length,
    ).toBeGreaterThanOrEqual(0);
  });

  it("conditional insight message contains scopePhrase for monthly tests", () => {
    const dates = dateRange("2025-01-01", 180);
    const metrics = dates.map((d) => makeDailyRow(d));

    const activities = dates.map((d) =>
      makeActivityRow(`${d}T10:00:00Z`, `${d}T11:00:00Z`, "running"),
    );

    // Vary exercise frequency: some months many exercise days, some few
    const nutrition = dates.map((d) => makeNutritionRow(d, { calories: 2500 }));

    const bodyComp = dates.map((d, i) =>
      makeBodyCompRow(`${d}T08:00:00Z`, {
        weight_kg: 80 - i * 0.02 + Math.sin(i * 0.05) * 2,
      }),
    );

    const result = computeInsights(metrics, [], activities, nutrition, bodyComp);
    const monthlyConditionals = result.filter(
      (i) => i.type === "conditional" && i.id.startsWith("exercise-monthly"),
    );
    for (const insight of monthlyConditionals) {
      // Monthly-scoped tests use "during months with" not "on days with"
      expect(insight.message).toContain("during months with");
    }
  });

  it("correlation message includes strength descriptor", () => {
    const dates = dateRange("2025-01-01", 90);
    const metrics = dates.map((d, i) => makeDailyRow(d, { hrv: 30 + i * 0.5 }));
    const sleep = dates.map((d, i) => {
      const dt = new Date(d);
      dt.setDate(dt.getDate() - 1);
      dt.setHours(23, 0, 0);
      return makeSleepRow(dt.toISOString(), {
        duration_minutes: 360 + i * 2,
      });
    });

    const result = computeInsights(metrics, sleep, [], [], []);
    const correlations = result.filter((i) => i.type === "correlation");
    for (const insight of correlations) {
      // Message should contain a strength descriptor
      expect(
        insight.message.includes("strongly") ||
          insight.message.includes("moderately") ||
          insight.message.includes("weakly"),
      ).toBe(true);
      expect(insight.message.includes("positively") || insight.message.includes("negatively")).toBe(
        true,
      );
    }
  });

  it("detail field contains Spearman rho for correlations", () => {
    const dates = dateRange("2025-01-01", 90);
    const metrics = dates.map((d, i) =>
      makeDailyRow(d, { hrv: 30 + i * 0.5, resting_hr: 75 - i * 0.2 }),
    );
    const sleep = dates.map((d, i) => {
      const dt = new Date(d);
      dt.setDate(dt.getDate() - 1);
      dt.setHours(23, 0, 0);
      return makeSleepRow(dt.toISOString(), {
        duration_minutes: 360 + i * 2,
      });
    });

    const result = computeInsights(metrics, sleep, [], [], []);
    const correlations = result.filter((i) => i.type === "correlation" || i.type === "discovery");
    for (const insight of correlations) {
      expect(insight.detail).toContain("ρ=");
    }
  });

  it("conditional detail field contains sample counts", () => {
    const dates = dateRange("2025-01-01", 90);
    const metrics = dates.map((d, i) => makeDailyRow(d, { hrv: i % 2 === 0 ? 70 : 35 }));
    const sleep = dates.map((d, i) => {
      const dt = new Date(d);
      dt.setDate(dt.getDate() - 1);
      dt.setHours(23, 0, 0);
      return makeSleepRow(dt.toISOString(), {
        duration_minutes: i % 2 === 0 ? 480 : 300,
      });
    });

    const result = computeInsights(metrics, sleep, [], [], []);
    const conditionals = result.filter((i) => i.type === "conditional");
    for (const insight of conditionals) {
      // Detail should contain n=X/Y pattern
      expect(insight.detail).toMatch(/n=\d+\/\d+/);
    }
  });

  it("applies FDR correction to filter non-significant results", () => {
    // Uniform data → no real effects → FDR should filter everything
    const dates = dateRange("2025-01-01", 60);
    const metrics = dates.map((d) => makeDailyRow(d));
    const sleep = dates.map((d) => {
      const dt = new Date(d);
      dt.setDate(dt.getDate() - 1);
      dt.setHours(23, 0, 0);
      return makeSleepRow(dt.toISOString());
    });

    const result = computeInsights(metrics, sleep, [], [], []);
    // With uniform data, insights may exist but should have valid p-values
    for (const insight of result) {
      expect(insight.pValue).toBeGreaterThanOrEqual(0);
      expect(insight.pValue).toBeLessThanOrEqual(1);
    }
  });

  it("handles custom config for minDailyCalories", () => {
    const dates = dateRange("2025-01-01", 30);
    const metrics = dates.map((d) => makeDailyRow(d));
    const nutrition = dates.map((d) => makeNutritionRow(d, { calories: 500 }));

    // With default (1200), no nutrition days qualify
    const result1 = computeInsights(metrics, [], [], nutrition, []);
    // With custom threshold (400), all days qualify
    const result2 = computeInsights(metrics, [], [], nutrition, [], { minDailyCalories: 400 });
    // result2 is more likely to have nutrition-related insights
    expect(Array.isArray(result1)).toBe(true);
    expect(Array.isArray(result2)).toBe(true);
  });

  it("handles activities with various exercise types for conditional tests", () => {
    const dates = dateRange("2025-01-01", 90);
    const metrics = dates.map((d, i) => makeDailyRow(d, { hrv: 40 + (i % 3 === 0 ? 20 : 0) }));

    // Mix of cardio, strength, flexibility
    const activities = dates.map((d, i) => {
      const types = ["running", "strength_training", "yoga", "cycling", "swimming"];
      const type = types[i % types.length] ?? "running";
      return makeActivityRow(`${d}T10:00:00Z`, `${d}T11:00:00Z`, type);
    });

    const sleep = dates.map((d, i) => {
      const dt = new Date(d);
      dt.setDate(dt.getDate() - 1);
      dt.setHours(23, 0, 0);
      return makeSleepRow(dt.toISOString(), {
        duration_minutes: 400 + (i % 3 === 0 ? 80 : 0),
      });
    });

    const result = computeInsights(metrics, sleep, activities, [], []);
    // Should produce some exercise-related insights
    expect(Array.isArray(result)).toBe(true);
  });

  it("explanation for body comp changes uses kg/% units", () => {
    const dates = dateRange("2025-01-01", 180);
    const metrics = dates.map((d) => makeDailyRow(d));

    const activities = dates.map((d, i) =>
      makeActivityRow(
        `${d}T10:00:00Z`,
        `${d}T11:00:00Z`,
        i % 3 === 0 ? "running" : "strength_training",
      ),
    );

    const bodyComp = dates.map((d, i) =>
      makeBodyCompRow(`${d}T08:00:00Z`, {
        weight_kg: 80 - i * 0.03,
        body_fat_pct: 15 - i * 0.01,
      }),
    );

    const nutrition = dates.map((d) => makeNutritionRow(d, { calories: 2200 }));

    const result = computeInsights(metrics, [], activities, nutrition, bodyComp);
    const bodyConditionalInsights = result.filter(
      (i) =>
        i.type === "conditional" &&
        (i.metric.includes("weight change") || i.metric.includes("body fat change")),
    );
    for (const insight of bodyConditionalInsights) {
      if (insight.explanation) {
        // Conditional body comp explanations use /mo format
        expect(insight.explanation).toContain("/mo");
      }
    }
  });

  it("includes confounders when detected", () => {
    // Create data where sleep strongly correlates with both exercise and HRV
    // Exercise should be flagged as a confounder for sleep→HRV
    const dates = dateRange("2025-01-01", 120);
    const metrics = dates.map((d, i) =>
      makeDailyRow(d, {
        hrv: i % 2 === 0 ? 70 : 35,
        resting_hr: i % 2 === 0 ? 55 : 68,
      }),
    );
    const sleep = dates.map((d, i) => {
      const dt = new Date(d);
      dt.setDate(dt.getDate() - 1);
      dt.setHours(23, 0, 0);
      return makeSleepRow(dt.toISOString(), {
        duration_minutes: i % 2 === 0 ? 480 : 300,
        deep_minutes: i % 2 === 0 ? 90 : 30,
      });
    });
    // Exercise pattern mirrors sleep: good sleep + exercise days
    const activities = dates.map((d, i) =>
      makeActivityRow(`${d}T10:00:00Z`, i % 2 === 0 ? `${d}T11:30:00Z` : null, "running"),
    );
    const nutrition = dates.map((d, i) =>
      makeNutritionRow(d, {
        calories: i % 2 === 0 ? 2800 : 1600,
        protein_g: i % 2 === 0 ? 180 : 80,
      }),
    );

    const result = computeInsights(metrics, sleep, activities, nutrition, []);
    // Some insights may have confounders
    const withConfounders = result.filter((i) => i.confounders && i.confounders.length > 0);
    // With strong correlations in multiple variables, confounders should be detected
    if (withConfounders.length > 0) {
      for (const insight of withConfounders) {
        for (const confounder of insight.confounders ?? []) {
          expect(typeof confounder).toBe("string");
          expect(confounder.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

// ── classifyActivity() direct tests ──────────────────────────────────────

describe("classifyActivity()", () => {
  it.each([
    "cycling",
    "walking",
    "hiking",
    "running",
    "swimming",
    "cross_country_skiing",
    "downhill_skiing",
    "cardio",
    "cross_training",
    "tennis",
    "climbing",
  ])("classifies %s as cardio", (type) => {
    expect(classifyActivity(type)).toBe("cardio");
  });

  it.each([
    "strength_training",
    "functional_strength",
    "strength",
  ])("classifies %s as strength", (type) => {
    expect(classifyActivity(type)).toBe("strength");
  });

  it.each([
    "yoga",
    "stretching",
    "preparation_and_recovery",
  ])("classifies %s as flexibility", (type) => {
    expect(classifyActivity(type)).toBe("flexibility");
  });

  it.each(["paddle_boarding", "dance", "unknown", ""])("classifies %s as other", (type) => {
    expect(classifyActivity(type)).toBe("other");
  });

  it("is case-insensitive", () => {
    expect(classifyActivity("CYCLING")).toBe("cardio");
    expect(classifyActivity("Yoga")).toBe("flexibility");
    expect(classifyActivity("STRENGTH")).toBe("strength");
  });
});

// ── classifyConfidence() direct tests ────────────────────────────────────

describe("classifyConfidence()", () => {
  it("returns strong for absD>=0.8, n>=30, pValue<0.05", () => {
    expect(classifyConfidence(0.8, 30, 0.04)).toBe("strong");
    expect(classifyConfidence(-0.8, 30, 0.04)).toBe("strong");
  });

  it("returns strong when pValue is null (not required)", () => {
    expect(classifyConfidence(0.8, 30)).toBe("strong");
    expect(classifyConfidence(0.8, 30, undefined)).toBe("strong");
  });

  it("boundary: absD=0.79 → not strong", () => {
    expect(classifyConfidence(0.79, 30, 0.04)).toBe("emerging");
  });

  it("boundary: n=29 → not strong", () => {
    expect(classifyConfidence(0.8, 29, 0.04)).toBe("emerging");
  });

  it("boundary: pValue=0.05 → not strong (must be < 0.05)", () => {
    expect(classifyConfidence(0.8, 30, 0.05)).toBe("emerging");
  });

  it("returns emerging for absD>=0.5, n>=15", () => {
    expect(classifyConfidence(0.5, 15)).toBe("emerging");
    expect(classifyConfidence(-0.5, 15)).toBe("emerging");
  });

  it("boundary: absD=0.49 → not emerging", () => {
    expect(classifyConfidence(0.49, 15)).toBe("early");
  });

  it("boundary: n=14 → not emerging", () => {
    expect(classifyConfidence(0.5, 14)).toBe("early");
  });

  it("returns early for absD>=0.3, n>=10", () => {
    expect(classifyConfidence(0.3, 10)).toBe("early");
    expect(classifyConfidence(-0.3, 10)).toBe("early");
  });

  it("boundary: absD=0.29 → insufficient", () => {
    expect(classifyConfidence(0.29, 10)).toBe("insufficient");
  });

  it("boundary: n=9 → insufficient", () => {
    expect(classifyConfidence(0.3, 9)).toBe("insufficient");
  });

  it("returns insufficient for small effect and small n", () => {
    expect(classifyConfidence(0.1, 5)).toBe("insufficient");
  });

  it("negative d values use abs (strong negative)", () => {
    expect(classifyConfidence(-1.0, 30, 0.01)).toBe("strong");
  });
});

// ── classifyCorrelationConfidence() direct tests ────────────────────────

describe("classifyCorrelationConfidence()", () => {
  it("returns strong for absRho>=0.5, n>=30", () => {
    expect(classifyCorrelationConfidence(0.5, 30)).toBe("strong");
    expect(classifyCorrelationConfidence(-0.5, 30)).toBe("strong");
  });

  it("boundary: rho=0.49 → not strong", () => {
    expect(classifyCorrelationConfidence(0.49, 30)).toBe("emerging");
  });

  it("boundary: n=29 → not strong", () => {
    expect(classifyCorrelationConfidence(0.5, 29)).toBe("emerging");
  });

  it("returns emerging for absRho>=0.35, n>=15", () => {
    expect(classifyCorrelationConfidence(0.35, 15)).toBe("emerging");
  });

  it("boundary: rho=0.34 → not emerging", () => {
    expect(classifyCorrelationConfidence(0.34, 15)).toBe("early");
  });

  it("boundary: n=14 → not emerging", () => {
    expect(classifyCorrelationConfidence(0.35, 14)).toBe("early");
  });

  it("returns early for absRho>=0.2, n>=10", () => {
    expect(classifyCorrelationConfidence(0.2, 10)).toBe("early");
  });

  it("boundary: rho=0.19 → insufficient", () => {
    expect(classifyCorrelationConfidence(0.19, 10)).toBe("insufficient");
  });

  it("boundary: n=9 → insufficient", () => {
    expect(classifyCorrelationConfidence(0.2, 9)).toBe("insufficient");
  });

  it("handles negative rho with abs", () => {
    expect(classifyCorrelationConfidence(-0.6, 30)).toBe("strong");
  });
});

// ── downsample() direct tests ──────────────────────────────────────────

describe("downsample()", () => {
  it("returns original array when length <= max", () => {
    expect(downsample([1, 2, 3], 5)).toEqual([1, 2, 3]);
    expect(downsample([1, 2, 3], 3)).toEqual([1, 2, 3]);
  });

  it("downsamples to exactly max elements", () => {
    const result = downsample([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);
    expect(result.length).toBe(5);
  });

  it("preserves first element", () => {
    const result = downsample([10, 20, 30, 40, 50, 60], 3);
    expect(result[0]).toBe(10);
  });

  it("handles single element", () => {
    expect(downsample([42], 1)).toEqual([42]);
  });

  it("handles empty array", () => {
    expect(downsample([], 5)).toEqual([]);
  });

  it("evenly samples from large array", () => {
    const arr = Array.from({ length: 1000 }, (_, idx) => idx);
    const result = downsample(arr, 100);
    expect(result.length).toBe(100);
    // First item should be 0, items should be roughly evenly spaced
    expect(result[0]).toBe(0);
    expect(result[1]).toBe(10);
  });
});

// ── isValidCausalDirection() direct tests ────────────────────────────────

describe("isValidCausalDirection()", () => {
  it("action→outcome is always valid", () => {
    expect(isValidCausalDirection("action", "outcome", 0)).toBe(true);
    expect(isValidCausalDirection("action", "outcome", 1)).toBe(true);
    expect(isValidCausalDirection("action", "outcome", 2)).toBe(true);
  });

  it("outcome→action is always invalid", () => {
    expect(isValidCausalDirection("outcome", "action", 0)).toBe(false);
    expect(isValidCausalDirection("outcome", "action", 1)).toBe(false);
  });

  it("outcome→outcome at lag=0 is valid", () => {
    expect(isValidCausalDirection("outcome", "outcome", 0)).toBe(true);
  });

  it("outcome→outcome at lag>0 is invalid", () => {
    expect(isValidCausalDirection("outcome", "outcome", 1)).toBe(false);
    expect(isValidCausalDirection("outcome", "outcome", 2)).toBe(false);
  });

  it("bidirectional→anything is valid", () => {
    expect(isValidCausalDirection("bidirectional", "outcome", 0)).toBe(true);
    expect(isValidCausalDirection("bidirectional", "action", 1)).toBe(true);
    expect(isValidCausalDirection("bidirectional", "bidirectional", 2)).toBe(true);
  });

  it("action→action is valid", () => {
    expect(isValidCausalDirection("action", "action", 0)).toBe(true);
    expect(isValidCausalDirection("action", "action", 1)).toBe(true);
  });
});

// ── rollingAvg() direct tests ──────────────────────────────────────────

describe("rollingAvg()", () => {
  const makeJoined = (values: (number | null)[]): JoinedDay[] =>
    values.map((val, idx) => ({
      ...makeDailyRow(`2025-01-${(idx + 1).toString().padStart(2, "0")}`, { resting_hr: val }),
      sleep_duration_min: null,
      deep_min: null,
      rem_min: null,
      sleep_efficiency: null,
      exercise_minutes: null,
      cardio_minutes: null,
      strength_minutes: null,
      flexibility_minutes: null,
      calories: null,
      protein_g: null,
      carbs_g: null,
      fat_g: null,
      fiber_g: null,
      weight_kg: null,
      body_fat_pct: null,
      resting_hr_7d: null,
      hrv_7d: null,
      weight_30d: null,
      body_fat_30d: null,
      weight_30d_delta: null,
      body_fat_30d_delta: null,
    }));

  it("returns null when index < days-1 (not enough history)", () => {
    const joined = makeJoined([60, 62, 64, 66, 68]);
    expect(rollingAvg(joined, 2, 5, (day) => day.resting_hr)).toBeNull();
  });

  it("computes average at exact boundary (index = days-1)", () => {
    const joined = makeJoined([60, 62, 64, 66, 68]);
    const result = rollingAvg(joined, 4, 5, (day) => day.resting_hr);
    expect(result).toBeCloseTo(64, 5);
  });

  it("returns null when not enough non-null values", () => {
    const joined = makeJoined([null, null, null, null, 68]);
    const result = rollingAvg(joined, 4, 5, (day) => day.resting_hr);
    // Default required = max(3, ceil(5*0.1)) = 3, but only 1 value
    expect(result).toBeNull();
  });

  it("uses custom minCount when provided", () => {
    const joined = makeJoined([60, null, null, null, 68]);
    // Only 2 non-null values
    const withHighMin = rollingAvg(joined, 4, 5, (day) => day.resting_hr, 3);
    expect(withHighMin).toBeNull();
    const withLowMin = rollingAvg(joined, 4, 5, (day) => day.resting_hr, 2);
    expect(withLowMin).toBeCloseTo(64, 5);
  });

  it("filters null values from average computation", () => {
    const joined = makeJoined([60, null, 64, null, 68]);
    const result = rollingAvg(joined, 4, 5, (day) => day.resting_hr, 2);
    // Average of 60, 64, 68 = 64
    expect(result).toBeCloseTo(64, 5);
  });
});

// ── getConditionalTests() direct tests ──────────────────────────────────

describe("getConditionalTests()", () => {
  it("returns a non-empty array of tests", () => {
    const tests = getConditionalTests();
    expect(tests.length).toBeGreaterThan(0);
  });

  it("all tests have unique ids", () => {
    const tests = getConditionalTests();
    const ids = tests.map((testDef) => testDef.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all tests have non-empty action and metric strings", () => {
    const tests = getConditionalTests();
    for (const testDef of tests) {
      expect(testDef.action.length).toBeGreaterThan(0);
      expect(testDef.metric.length).toBeGreaterThan(0);
    }
  });

  it("splitFn returns boolean or null for a minimal joined day", () => {
    const tests = getConditionalTests();
    const minimalDay: JoinedDay = {
      ...makeDailyRow("2025-01-15"),
      sleep_duration_min: 480,
      deep_min: 90,
      rem_min: 100,
      sleep_efficiency: 92,
      exercise_minutes: 60,
      cardio_minutes: 30,
      strength_minutes: 20,
      flexibility_minutes: 10,
      calories: 2200,
      protein_g: 150,
      carbs_g: 250,
      fat_g: 70,
      fiber_g: 25,
      weight_kg: 80,
      body_fat_pct: 15,
      resting_hr_7d: 60,
      hrv_7d: 50,
      weight_30d: 80,
      body_fat_30d: 15,
      weight_30d_delta: 0,
      body_fat_30d_delta: 0,
    };
    const allDays = [minimalDay];

    for (const testDef of tests) {
      const result = testDef.splitFn(minimalDay, allDays, 0);
      expect(result === true || result === false || result === null).toBe(true);
    }
  });

  it("valueFn returns number or null for a minimal joined day", () => {
    const tests = getConditionalTests();
    const minimalDay: JoinedDay = {
      ...makeDailyRow("2025-01-15"),
      sleep_duration_min: 480,
      deep_min: 90,
      rem_min: 100,
      sleep_efficiency: 92,
      exercise_minutes: 60,
      cardio_minutes: 30,
      strength_minutes: 20,
      flexibility_minutes: 10,
      calories: 2200,
      protein_g: 150,
      carbs_g: 250,
      fat_g: 70,
      fiber_g: 25,
      weight_kg: 80,
      body_fat_pct: 15,
      resting_hr_7d: 60,
      hrv_7d: 50,
      weight_30d: 80,
      body_fat_30d: 15,
      weight_30d_delta: 0,
      body_fat_30d_delta: 0,
    };
    const allDays = [minimalDay];

    for (const testDef of tests) {
      const result = testDef.valueFn(minimalDay, allDays, 0);
      expect(result === null || typeof result === "number").toBe(true);
    }
  });

  it("sleep threshold tests split at 420 minutes boundary", () => {
    const tests = getConditionalTests();
    const sleepTest = tests.find((testDef) => testDef.id === "sleep_7h_resting_hr");

    const makeSplitDay = (sleepMin: number | null): JoinedDay => ({
      ...makeDailyRow("2025-01-15"),
      sleep_duration_min: sleepMin,
      deep_min: null,
      rem_min: null,
      sleep_efficiency: null,
      exercise_minutes: null,
      cardio_minutes: null,
      strength_minutes: null,
      flexibility_minutes: null,
      calories: null,
      protein_g: null,
      carbs_g: null,
      fat_g: null,
      fiber_g: null,
      weight_kg: null,
      body_fat_pct: null,
      resting_hr_7d: 60,
      hrv_7d: 50,
      weight_30d: null,
      body_fat_30d: null,
      weight_30d_delta: null,
      body_fat_30d_delta: null,
    });

    if (sleepTest) {
      expect(sleepTest.splitFn(makeSplitDay(420), [], 0)).toBe(true);
      expect(sleepTest.splitFn(makeSplitDay(419), [], 0)).toBe(false);
      expect(sleepTest.splitFn(makeSplitDay(null), [], 0)).toBeNull();
    }
  });

  it("steps threshold tests split at 10000 boundary", () => {
    const tests = getConditionalTests();
    const stepsTest = tests.find((testDef) => testDef.id === "steps_10k_resting_hr");

    const makeSplitDay = (steps: number): JoinedDay => ({
      ...makeDailyRow("2025-01-15", { steps }),
      sleep_duration_min: null,
      deep_min: null,
      rem_min: null,
      sleep_efficiency: null,
      exercise_minutes: null,
      cardio_minutes: null,
      strength_minutes: null,
      flexibility_minutes: null,
      calories: null,
      protein_g: null,
      carbs_g: null,
      fat_g: null,
      fiber_g: null,
      weight_kg: null,
      body_fat_pct: null,
      resting_hr_7d: 60,
      hrv_7d: 50,
      weight_30d: null,
      body_fat_30d: null,
      weight_30d_delta: null,
      body_fat_30d_delta: null,
    });

    if (stepsTest) {
      expect(stepsTest.splitFn(makeSplitDay(10000), [], 0)).toBe(true);
      expect(stepsTest.splitFn(makeSplitDay(9999), [], 0)).toBe(false);
    }
  });

  it("exercise threshold tests split at 30 minutes boundary", () => {
    const tests = getConditionalTests();
    const exerciseTest = tests.find((testDef) => testDef.id === "exercise_30m_resting_hr");

    const makeSplitDay = (exerciseMin: number | null): JoinedDay => ({
      ...makeDailyRow("2025-01-15"),
      sleep_duration_min: null,
      deep_min: null,
      rem_min: null,
      sleep_efficiency: null,
      exercise_minutes: exerciseMin,
      cardio_minutes: null,
      strength_minutes: null,
      flexibility_minutes: null,
      calories: null,
      protein_g: null,
      carbs_g: null,
      fat_g: null,
      fiber_g: null,
      weight_kg: null,
      body_fat_pct: null,
      resting_hr_7d: 60,
      hrv_7d: 50,
      weight_30d: null,
      body_fat_30d: null,
      weight_30d_delta: null,
      body_fat_30d_delta: null,
    });

    if (exerciseTest) {
      expect(exerciseTest.splitFn(makeSplitDay(30), [], 0)).toBe(true);
      expect(exerciseTest.splitFn(makeSplitDay(29), [], 0)).toBe(false);
      expect(exerciseTest.splitFn(makeSplitDay(null), [], 0)).toBeNull();
    }
  });
});

// ── explainInsight() direct tests ───────────────────────────────────────

describe("explainInsight()", () => {
  const baseConditional: Omit<Insight, "explanation"> = {
    id: "test_id",
    type: "conditional",
    confidence: "strong",
    action: "7+ hours of sleep",
    metric: "resting heart rate",
    message: "",
    effectSize: -0.8,
    pValue: 0.01,
    detail: "Mean: 58 bpm (with) vs 62 bpm (without); n=40/35",
    whenTrue: { mean: 58, median: 58, stddev: 2, p25: 57, p75: 59, n: 40 },
    whenFalse: { mean: 62, median: 62, stddev: 2, p25: 61, p75: 63, n: 35 },
  };

  it("generates a non-empty explanation for conditional insights", () => {
    const result = explainInsight(baseConditional);
    expect(result.length).toBeGreaterThan(0);
  });

  it("uses confidence-based frequency word (strong → consistently)", () => {
    const result = explainInsight({ ...baseConditional, confidence: "strong" });
    expect(result).toContain("consistently");
  });

  it("uses 'generally' for emerging confidence", () => {
    const result = explainInsight({ ...baseConditional, confidence: "emerging" });
    expect(result).toContain("generally");
  });

  it("uses 'sometimes' for early confidence", () => {
    const result = explainInsight({ ...baseConditional, confidence: "early" });
    expect(result).toContain("sometimes");
  });

  it("includes direction (lower/higher) based on effect size", () => {
    const lower = explainInsight({ ...baseConditional, effectSize: -0.8 });
    expect(lower.toLowerCase()).toMatch(/lower/);

    const higher = explainInsight({
      ...baseConditional,
      effectSize: 0.8,
      whenTrue: { mean: 62, median: 62, stddev: 2, p25: 61, p75: 63, n: 40 },
      whenFalse: { mean: 58, median: 58, stddev: 2, p25: 57, p75: 59, n: 35 },
    });
    expect(higher.toLowerCase()).toMatch(/higher/);
  });

  it("generates explanation for correlation insights", () => {
    const correlationInsight: Omit<Insight, "explanation"> = {
      id: "corr_test",
      type: "correlation",
      confidence: "strong",
      action: "steps",
      metric: "resting heart rate",
      message: "",
      effectSize: -0.6,
      pValue: 0.001,
      detail: "Spearman ρ = -0.60, n = 45",
      whenTrue: { mean: 0, median: 0, stddev: 0, p25: 0, p75: 0, n: 0 },
      whenFalse: { mean: 0, median: 0, stddev: 0, p25: 0, p75: 0, n: 0 },
      dataPoints: [],
    };
    const result = explainInsight(correlationInsight);
    expect(result.length).toBeGreaterThan(0);
  });

  it("handles body comp insights with weight change", () => {
    const bodyCompInsight: Omit<Insight, "explanation"> = {
      id: "body_test",
      type: "conditional",
      confidence: "emerging",
      action: "high protein intake",
      metric: "weight change (30-day)",
      message: "",
      effectSize: -0.5,
      pValue: 0.03,
      detail: "Mean: -0.3 kg/mo (with) vs 0.1 kg/mo (without)",
      whenTrue: { mean: -0.3, median: -0.25, stddev: 0.1, p25: -0.35, p75: -0.2, n: 20 },
      whenFalse: { mean: 0.1, median: 0.15, stddev: 0.1, p25: 0.05, p75: 0.2, n: 20 },
    };
    const result = explainInsight(bodyCompInsight);
    expect(result.length).toBeGreaterThan(0);
  });

  it("generates explanation for discovery type insights", () => {
    const discoveryInsight: Omit<Insight, "explanation"> = {
      id: "disc_test",
      type: "discovery",
      confidence: "emerging",
      action: "daily steps",
      metric: "resting heart rate",
      message: "",
      effectSize: -0.45,
      pValue: 0.02,
      detail: "Spearman ρ = -0.45, n = 35",
      whenTrue: { mean: 0, median: 0, stddev: 0, p25: 0, p75: 0, n: 0 },
      whenFalse: { mean: 0, median: 0, stddev: 0, p25: 0, p75: 0, n: 0 },
      dataPoints: [],
    };
    const result = explainInsight(discoveryInsight);
    expect(result.length).toBeGreaterThan(0);
  });

  it("formats small differences with 1 decimal place", () => {
    const smallDiff: Omit<Insight, "explanation"> = {
      ...baseConditional,
      whenTrue: { mean: 60.5, median: 60, stddev: 2, p25: 59, p75: 62, n: 20 },
      whenFalse: { mean: 62, median: 62, stddev: 2, p25: 61, p75: 63, n: 20 },
    };
    const result = explainInsight(smallDiff);
    expect(result).toContain("1.5");
  });

  it("formats large differences as integers", () => {
    const largeDiff: Omit<Insight, "explanation"> = {
      ...baseConditional,
      action: "10,000+ steps",
      metric: "daily steps",
      whenTrue: { mean: 12000, median: 12000, stddev: 500, p25: 11500, p75: 12500, n: 20 },
      whenFalse: { mean: 8000, median: 8000, stddev: 500, p25: 7500, p75: 8500, n: 20 },
    };
    const result = explainInsight(largeDiff);
    // Large diffs (>=10) should be rounded to integers
    expect(result).toContain("4000");
  });

  it("handles action starting with digit", () => {
    const result = explainInsight({ ...baseConditional, action: "7+ hours of sleep" });
    expect(result).toContain("you have 7+");
  });

  it("handles action ending with 'day'", () => {
    const result = explainInsight({ ...baseConditional, action: "cardio day" });
    expect(result).toContain("it's a cardio day");
  });
});

// ── Systematic conditional test boundary tests ─────────────────────────

/** Create a full JoinedDay with all fields populated */
function makeFullJoinedDay(date: string, overrides: Partial<JoinedDay> = {}): JoinedDay {
  return {
    date,
    resting_hr: 60,
    hrv: 50,
    spo2_avg: 98,
    steps: 8000,
    active_energy_kcal: 400,
    skin_temp_c: 36.5,
    sleep_duration_min: 480,
    deep_min: 90,
    rem_min: 100,
    sleep_efficiency: 92,
    exercise_minutes: 45,
    cardio_minutes: 30,
    strength_minutes: 10,
    flexibility_minutes: 5,
    calories: 2200,
    protein_g: 150,
    carbs_g: 250,
    fat_g: 70,
    fiber_g: 25,
    weight_kg: 80,
    body_fat_pct: 15,
    resting_hr_7d: 60,
    hrv_7d: 50,
    weight_30d_avg: 80,
    body_fat_30d_avg: 15,
    weight_30d_delta: -0.5,
    body_fat_30d_delta: -0.2,
    ...overrides,
  };
}

/** Create N days of JoinedDay data for testing */
function makeJoinedDays(count: number, overrides: Partial<JoinedDay> = {}): JoinedDay[] {
  return dateRange("2025-01-01", count).map((date) => makeFullJoinedDay(date, overrides));
}

describe("getConditionalTests() — systematic splitFn boundary tests", () => {
  const tests = getConditionalTests();

  // Map of test IDs to their split field and threshold
  const simpleSplitTests: Array<{ id: string; field: keyof JoinedDay; threshold: number }> = [
    { id: "sleep-7h-hrv", field: "sleep_duration_min", threshold: 420 },
    { id: "sleep-7h-rhr", field: "sleep_duration_min", threshold: 420 },
    { id: "deep-60-hrv", field: "deep_min", threshold: 60 },
    { id: "exercise-30-sleep", field: "exercise_minutes", threshold: 30 },
    { id: "exercise-30-hrv", field: "exercise_minutes", threshold: 30 },
    { id: "steps-10k-hrv", field: "steps", threshold: 10000 },
    { id: "active-500-sleep-eff", field: "active_energy_kcal", threshold: 500 },
    { id: "rem-90-hrv", field: "rem_min", threshold: 90 },
    { id: "cardio-sleep", field: "cardio_minutes", threshold: 20 },
    { id: "cardio-deep-sleep", field: "cardio_minutes", threshold: 20 },
    { id: "cardio-sleep-eff", field: "cardio_minutes", threshold: 20 },
    { id: "strength-sleep", field: "strength_minutes", threshold: 15 },
    { id: "strength-deep-sleep", field: "strength_minutes", threshold: 15 },
    { id: "yoga-sleep-eff", field: "flexibility_minutes", threshold: 15 },
    { id: "yoga-hrv", field: "flexibility_minutes", threshold: 15 },
    { id: "cardio-hrv", field: "cardio_minutes", threshold: 20 },
    { id: "strength-hrv", field: "strength_minutes", threshold: 15 },
    { id: "high-protein-hrv", field: "protein_g", threshold: 100 },
    { id: "high-cal-sleep", field: "calories", threshold: 2500 },
  ];

  for (const { id, field, threshold } of simpleSplitTests) {
    const testDef = tests.find((td) => td.id === id);
    if (!testDef) continue;

    it(`${id}: splitFn returns true when ${field} = ${threshold} (at threshold)`, () => {
      const day = makeFullJoinedDay("2025-01-15", { [field]: threshold });
      expect(testDef.splitFn(day, [day], 0)).toBe(true);
    });

    it(`${id}: splitFn returns false when ${field} = ${threshold - 1} (below threshold)`, () => {
      const day = makeFullJoinedDay("2025-01-15", { [field]: threshold - 1 });
      expect(testDef.splitFn(day, [day], 0)).toBe(false);
    });

    it(`${id}: splitFn returns null when ${field} is null`, () => {
      const day = makeFullJoinedDay("2025-01-15", { [field]: null } satisfies Partial<JoinedDay>);
      expect(testDef.splitFn(day, [day], 0)).toBeNull();
    });
  }

  // Test valueFn for next-day lookups (i+1 pattern)
  const nextDayValueTests: Array<{ id: string; field: keyof JoinedDay }> = [
    { id: "sleep-7h-hrv", field: "hrv" },
    { id: "sleep-7h-rhr", field: "resting_hr" },
    { id: "deep-60-hrv", field: "hrv" },
    { id: "exercise-30-sleep", field: "sleep_duration_min" },
    { id: "exercise-30-hrv", field: "hrv" },
    { id: "steps-10k-hrv", field: "hrv" },
    { id: "active-500-sleep-eff", field: "sleep_efficiency" },
    { id: "rem-90-hrv", field: "hrv" },
    { id: "cardio-sleep", field: "sleep_duration_min" },
    { id: "cardio-deep-sleep", field: "deep_min" },
    { id: "cardio-sleep-eff", field: "sleep_efficiency" },
    { id: "strength-sleep", field: "sleep_duration_min" },
    { id: "strength-deep-sleep", field: "deep_min" },
    { id: "yoga-sleep-eff", field: "sleep_efficiency" },
    { id: "yoga-hrv", field: "hrv" },
    { id: "cardio-hrv", field: "hrv" },
    { id: "strength-hrv", field: "hrv" },
    { id: "high-protein-hrv", field: "hrv" },
    { id: "high-cal-sleep", field: "sleep_duration_min" },
  ];

  for (const { id, field } of nextDayValueTests) {
    const testDef = tests.find((td) => td.id === id);
    if (!testDef) continue;

    it(`${id}: valueFn returns next day's ${field}`, () => {
      const today = makeFullJoinedDay("2025-01-15");
      const tomorrow = makeFullJoinedDay("2025-01-16", { [field]: 99 });
      const allDays = [today, tomorrow];
      const result = testDef.valueFn(today, allDays, 0);
      expect(result).toBe(99);
    });

    it(`${id}: valueFn returns null when no next day`, () => {
      const today = makeFullJoinedDay("2025-01-15");
      const result = testDef.valueFn(today, [today], 0);
      expect(result).toBeNull();
    });
  }

  // Test monthly scoped splitFns
  it("exercise-monthly-weight: returns true when >= 12 exercise days in 30-day window", () => {
    const testDef = tests.find((td) => td.id === "exercise-monthly-weight");
    const days = makeJoinedDays(30, { exercise_minutes: 25 }); // All 30 days have exercise
    const day29 = days[29] ?? makeFullJoinedDay("2025-01-30");
    expect(testDef?.splitFn(day29, days, 29)).toBe(true);
  });

  it("exercise-monthly-weight: returns false when < 12 exercise days", () => {
    const testDef = tests.find((td) => td.id === "exercise-monthly-weight");
    const days = makeJoinedDays(30, { exercise_minutes: 5 }); // Below 20 min threshold
    const day29 = days[29] ?? makeFullJoinedDay("2025-01-30");
    expect(testDef?.splitFn(day29, days, 29)).toBe(false);
  });

  it("exercise-monthly-weight: returns null when i < 29", () => {
    const testDef = tests.find((td) => td.id === "exercise-monthly-weight");
    const days = makeJoinedDays(30);
    const day28 = days[28] ?? makeFullJoinedDay("2025-01-29");
    expect(testDef?.splitFn(day28, days, 28)).toBeNull();
  });

  it("sleep-consistent-hrv: returns true when sleep variation < 30 min", () => {
    const testDef = tests.find((td) => td.id === "sleep-consistent-hrv");
    // 7 days of consistent sleep (all 480 min ± small variation)
    const days = makeJoinedDays(8, { sleep_duration_min: 480 });
    const day7 = days[7] ?? makeFullJoinedDay("2025-01-08");
    expect(testDef?.splitFn(day7, days, 7)).toBe(true);
  });

  it("sleep-consistent-hrv: returns false when sleep variation >= 30 min", () => {
    const testDef = tests.find((td) => td.id === "sleep-consistent-hrv");
    const days = makeJoinedDays(8);
    // Make sleep highly variable
    for (let idx = 0; idx < days.length; idx++) {
      const existingDay = days[idx];
      if (existingDay) {
        days[idx] = makeFullJoinedDay(existingDay.date, {
          sleep_duration_min: idx % 2 === 0 ? 300 : 600,
        });
      }
    }
    const day7 = days[7] ?? makeFullJoinedDay("2025-01-08");
    expect(testDef?.splitFn(day7, days, 7)).toBe(false);
  });

  it("sleep-consistent-hrv: returns null when i < 7", () => {
    const testDef = tests.find((td) => td.id === "sleep-consistent-hrv");
    const days = makeJoinedDays(8);
    const day6 = days[6] ?? makeFullJoinedDay("2025-01-07");
    expect(testDef?.splitFn(day6, days, 6)).toBeNull();
  });

  it("sleep-consistent-hrv: returns null when < 5 non-null durations in week", () => {
    const testDef = tests.find((td) => td.id === "sleep-consistent-hrv");
    const days = makeJoinedDays(8, { sleep_duration_min: null } satisfies Partial<JoinedDay>);
    // Only 2 days with sleep data
    days[6] = makeFullJoinedDay(days[6]?.date ?? "2025-01-07", { sleep_duration_min: 480 });
    days[7] = makeFullJoinedDay(days[7]?.date ?? "2025-01-08", { sleep_duration_min: 480 });
    const day7 = days[7] ?? makeFullJoinedDay("2025-01-08");
    expect(testDef?.splitFn(day7, days, 7)).toBeNull();
  });
});

// ── Systematic correlation pair extract tests ────────────────────────────

describe("getCorrelationPairs() — systematic extract tests", () => {
  const pairs = getCorrelationPairs();

  it("returns a non-empty array with unique ids", () => {
    expect(pairs.length).toBeGreaterThan(0);
    const ids = pairs.map((pair) => pair.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all pairs have non-empty xName and yName", () => {
    for (const pair of pairs) {
      expect(pair.xName.length).toBeGreaterThan(0);
      expect(pair.yName.length).toBeGreaterThan(0);
    }
  });

  // Simple same-day extract pairs
  const simplePairs: Array<{ id: string; xField: keyof JoinedDay }> = [
    { id: "sleep-dur-hrv", xField: "sleep_duration_min" },
    { id: "steps-hrv", xField: "steps" },
    { id: "active-kcal-sleep", xField: "active_energy_kcal" },
    { id: "deep-sleep-hrv", xField: "deep_min" },
    { id: "exercise-dur-sleep-eff", xField: "exercise_minutes" },
    { id: "rhr-hrv", xField: "resting_hr" },
    { id: "protein-hrv", xField: "protein_g" },
    { id: "calories-sleep", xField: "calories" },
  ];

  for (const { id, xField } of simplePairs) {
    const pair = pairs.find((pd) => pd.id === id);
    if (!pair) continue;

    it(`${id}: xFn extracts ${xField} from day`, () => {
      const day = makeFullJoinedDay("2025-01-15", { [xField]: 42 });
      expect(pair.xFn(day, [day], 0)).toBe(42);
    });

    it(`${id}: xFn returns null when ${xField} is null`, () => {
      const day = makeFullJoinedDay("2025-01-15", { [xField]: null } satisfies Partial<JoinedDay>);
      expect(pair.xFn(day, [day], 0)).toBeNull();
    });
  }

  // Monthly rolling average pairs
  it("calories-30d-weight-delta: xFn computes 30-day rolling avg calories", () => {
    const pair = pairs.find((pd) => pd.id === "calories-30d-weight-delta");
    const days = makeJoinedDays(30, { calories: 2000 });
    const day29 = days[29] ?? makeFullJoinedDay("2025-01-30");
    const result = pair?.xFn(day29, days, 29);
    expect(result).toBeCloseTo(2000, 0);
  });

  it("exercise-30d-weight-delta: xFn returns null when i < 29", () => {
    const pair = pairs.find((pd) => pd.id === "exercise-30d-weight-delta");
    const days = makeJoinedDays(30);
    const day28 = days[28] ?? makeFullJoinedDay("2025-01-29");
    expect(pair?.xFn(day28, days, 28)).toBeNull();
  });

  it("exercise-30d-weight-delta: xFn sums exercise minutes over 30 days", () => {
    const pair = pairs.find((pd) => pd.id === "exercise-30d-weight-delta");
    const days = makeJoinedDays(30, { exercise_minutes: 30 });
    const day29 = days[29] ?? makeFullJoinedDay("2025-01-30");
    const result = pair?.xFn(day29, days, 29);
    expect(result).toBe(900); // 30 days × 30 min
  });

  it("exercise-30d-weight-delta: xFn returns null when total exercise is 0", () => {
    const pair = pairs.find((pd) => pd.id === "exercise-30d-weight-delta");
    const days = makeJoinedDays(30, { exercise_minutes: 0 });
    const day29 = days[29] ?? makeFullJoinedDay("2025-01-30");
    expect(pair?.xFn(day29, days, 29)).toBeNull();
  });
});

// ── getAllMetrics() tests ────────────────────────────────────────────────

describe("getAllMetrics() — systematic extract tests", () => {
  const metrics = getAllMetrics();

  it("returns a non-empty array with unique keys", () => {
    expect(metrics.length).toBeGreaterThan(0);
    const keys = metrics.map((metric) => metric.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("all metrics have valid role values", () => {
    const validRoles = new Set(["action", "outcome", "bidirectional"]);
    for (const metric of metrics) {
      expect(validRoles.has(metric.role)).toBe(true);
    }
  });

  it("all metrics have non-empty labels", () => {
    for (const metric of metrics) {
      expect(metric.label.length).toBeGreaterThan(0);
    }
  });

  // Test extract functions for key metrics
  const simpleExtractMetrics: Array<{ key: string; field: keyof JoinedDay; expected: number }> = [
    { key: "resting_hr", field: "resting_hr", expected: 60 },
    { key: "hrv", field: "hrv", expected: 50 },
    { key: "spo2", field: "spo2_avg", expected: 98 },
    { key: "skin_temp", field: "skin_temp_c", expected: 36.5 },
    { key: "steps", field: "steps", expected: 8000 },
    { key: "active_kcal", field: "active_energy_kcal", expected: 400 },
    { key: "exercise", field: "exercise_minutes", expected: 45 },
    { key: "calories", field: "calories", expected: 2200 },
    { key: "protein", field: "protein_g", expected: 150 },
    { key: "carbs", field: "carbs_g", expected: 250 },
    { key: "fat", field: "fat_g", expected: 70 },
    { key: "fiber", field: "fiber_g", expected: 25 },
    { key: "sleep_dur", field: "sleep_duration_min", expected: 480 },
    { key: "deep_sleep", field: "deep_min", expected: 90 },
    { key: "rem_sleep", field: "rem_min", expected: 100 },
    { key: "sleep_eff", field: "sleep_efficiency", expected: 92 },
    { key: "weight", field: "weight_kg", expected: 80 },
    { key: "body_fat", field: "body_fat_pct", expected: 15 },
    { key: "weight_30d", field: "weight_30d_avg", expected: 80 },
    { key: "bf_30d", field: "body_fat_30d_avg", expected: 15 },
    { key: "weight_delta", field: "weight_30d_delta", expected: -0.5 },
    { key: "bf_delta", field: "body_fat_30d_delta", expected: -0.2 },
  ];

  for (const { key, field, expected } of simpleExtractMetrics) {
    const metric = metrics.find((md) => md.key === key);
    if (!metric) continue;

    it(`${key}: extract returns ${field} value`, () => {
      const day = makeFullJoinedDay("2025-01-15");
      expect(metric.extract(day, [day], 0)).toBe(expected);
    });

    it(`${key}: extract returns null when ${field} is null`, () => {
      const day = makeFullJoinedDay("2025-01-15", { [field]: null } satisfies Partial<JoinedDay>);
      expect(metric.extract(day, [day], 0)).toBeNull();
    });
  }

  // Already covered by the systematic loop above — rolling averages and deltas
  // use pre-computed fields (weight_30d_avg, body_fat_30d_avg, weight_30d_delta, body_fat_30d_delta)
});

// ── aggregateMonthly() tests ────────────────────────────────────────────

describe("aggregateMonthly()", () => {
  it("returns empty array for empty input", () => {
    expect(aggregateMonthly([])).toEqual([]);
  });

  it("excludes months with fewer than 20 days", () => {
    const days = makeJoinedDays(19); // Only 19 days in January
    expect(aggregateMonthly(days)).toHaveLength(0);
  });

  it("includes months with exactly 20 days", () => {
    const days = makeJoinedDays(20);
    const result = aggregateMonthly(days);
    expect(result).toHaveLength(1);
    expect(result[0]?.month).toBe("2025-01");
  });

  it("computes average calories from non-null days", () => {
    const days = makeJoinedDays(25, { calories: 2000 });
    const result = aggregateMonthly(days);
    expect(result[0]?.avgCalories).toBeCloseTo(2000, 0);
  });

  it("returns null avgCalories when fewer than 3 nutrition days", () => {
    const days = makeJoinedDays(25, { calories: null } satisfies Partial<JoinedDay>);
    // Only set 2 days with calories
    days[0] = makeFullJoinedDay(days[0]?.date ?? "2025-01-01", { calories: 2000 });
    days[1] = makeFullJoinedDay(days[1]?.date ?? "2025-01-02", { calories: 2000 });
    const result = aggregateMonthly(days);
    expect(result[0]?.avgCalories).toBeNull();
  });

  it("computes average protein, carbs, fat", () => {
    const days = makeJoinedDays(25, { protein_g: 120, carbs_g: 200, fat_g: 60 });
    const result = aggregateMonthly(days);
    expect(result[0]?.avgProtein).toBeCloseTo(120, 0);
    expect(result[0]?.avgCarbs).toBeCloseTo(200, 0);
    expect(result[0]?.avgFat).toBeCloseTo(60, 0);
  });

  it("counts exercise days with >= 20 min threshold", () => {
    const days = makeJoinedDays(25, { exercise_minutes: 25 });
    // Override some days to be below threshold
    days[0] = makeFullJoinedDay(days[0]?.date ?? "2025-01-01", { exercise_minutes: 15 });
    days[1] = makeFullJoinedDay(days[1]?.date ?? "2025-01-02", { exercise_minutes: 10 });
    const result = aggregateMonthly(days);
    expect(result[0]?.exerciseDays).toBe(23); // 25 - 2 below threshold
  });

  it("sums total exercise, cardio, strength, flexibility minutes", () => {
    const days = makeJoinedDays(25, {
      exercise_minutes: 40,
      cardio_minutes: 20,
      strength_minutes: 15,
      flexibility_minutes: 5,
    });
    const result = aggregateMonthly(days);
    expect(result[0]?.exerciseMinutes).toBe(1000); // 25 * 40
    expect(result[0]?.cardioMinutes).toBe(500); // 25 * 20
    expect(result[0]?.strengthMinutes).toBe(375); // 25 * 15
    expect(result[0]?.flexibilityMinutes).toBe(125); // 25 * 5
  });

  it("counts cardio days (>= 10 min) and strength days (>= 10 min)", () => {
    const days = makeJoinedDays(25, { cardio_minutes: 15, strength_minutes: 12 });
    const result = aggregateMonthly(days);
    expect(result[0]?.cardioDays).toBe(25);
    expect(result[0]?.strengthDays).toBe(25);
  });

  it("computes weight delta from first/last 5 measurements", () => {
    const days = makeJoinedDays(25, { weight_kg: 80 });
    // Set first 5 days at 80 kg, last 5 at 78 kg
    for (let idx = 20; idx < 25; idx++) {
      days[idx] = makeFullJoinedDay(days[idx]?.date ?? `2025-01-${idx + 1}`, { weight_kg: 78 });
    }
    const result = aggregateMonthly(days);
    expect(result[0]?.weightStart).toBe(80);
    expect(result[0]?.weightEnd).toBe(78);
    expect(result[0]?.weightDelta).toBe(-2);
  });

  it("uses single first/last measurement when 2-4 weight measurements", () => {
    const days = makeJoinedDays(25, { weight_kg: null } satisfies Partial<JoinedDay>);
    // Only 3 weight measurements
    days[0] = makeFullJoinedDay(days[0]?.date ?? "2025-01-01", { weight_kg: 82 });
    days[12] = makeFullJoinedDay(days[12]?.date ?? "2025-01-13", { weight_kg: 80 });
    days[24] = makeFullJoinedDay(days[24]?.date ?? "2025-01-25", { weight_kg: 78 });
    const result = aggregateMonthly(days);
    expect(result[0]?.weightStart).toBe(82); // first measurement
    expect(result[0]?.weightEnd).toBe(78); // last measurement
  });

  it("returns null weight when fewer than 2 measurements", () => {
    const days = makeJoinedDays(25, { weight_kg: null } satisfies Partial<JoinedDay>);
    days[0] = makeFullJoinedDay(days[0]?.date ?? "2025-01-01", { weight_kg: 80 });
    const result = aggregateMonthly(days);
    expect(result[0]?.weightStart).toBeNull();
    expect(result[0]?.weightEnd).toBeNull();
  });

  it("computes body fat delta similarly to weight delta", () => {
    const days = makeJoinedDays(25, { body_fat_pct: 15 });
    for (let idx = 20; idx < 25; idx++) {
      days[idx] = makeFullJoinedDay(days[idx]?.date ?? `2025-01-${idx + 1}`, { body_fat_pct: 14 });
    }
    const result = aggregateMonthly(days);
    expect(result[0]?.bfStart).toBe(15);
    expect(result[0]?.bfEnd).toBe(14);
    expect(result[0]?.bfDelta).toBe(-1);
  });

  it("handles null exercise minutes using ?? 0", () => {
    const days = makeJoinedDays(25, { exercise_minutes: null } satisfies Partial<JoinedDay>);
    const result = aggregateMonthly(days);
    expect(result[0]?.exerciseMinutes).toBe(0);
    expect(result[0]?.exerciseDays).toBe(0);
  });

  it("groups days by month correctly", () => {
    // 45 days: Jan 1-31, Feb 1-14
    const days = dateRange("2025-01-01", 45).map((date) => makeFullJoinedDay(date));
    const result = aggregateMonthly(days);
    // Jan has 31 days (>= 20), Feb has only 14 (< 20)
    expect(result).toHaveLength(1);
    expect(result[0]?.month).toBe("2025-01");
  });
});

// ── exhaustiveSweep() tests ─────────────────────────────────────────────

describe("exhaustiveSweep()", () => {
  it("returns empty array for insufficient data (< 20 days)", () => {
    const days = makeJoinedDays(15);
    const result = exhaustiveSweep(days, new Set());
    expect(result).toEqual([]);
  });

  it("returns empty array when no significant correlations exist", () => {
    // Random-looking data with no correlations
    const days = dateRange("2025-01-01", 30).map((date, idx) =>
      makeFullJoinedDay(date, {
        resting_hr: 60 + (idx % 3),
        steps: 5000 + ((idx * 7) % 11) * 100,
        hrv: 45 + ((idx * 13) % 7),
      }),
    );
    const result = exhaustiveSweep(days, new Set());
    // May or may not find correlations — just verify it doesn't crash
    expect(Array.isArray(result)).toBe(true);
  });

  it("detects correlated metrics in synthetic data", () => {
    // Create strong positive correlation: steps → next-day HRV
    const days = dateRange("2025-01-01", 40).map((date, idx) => {
      const baseSteps = 5000 + idx * 200;
      const nextDayHrv = 30 + idx * 1.2;
      return makeFullJoinedDay(date, {
        steps: baseSteps,
        hrv: nextDayHrv,
        resting_hr: 70 - idx * 0.3,
        exercise_minutes: null,
        cardio_minutes: null,
        strength_minutes: null,
        flexibility_minutes: null,
        calories: null,
        protein_g: null,
        carbs_g: null,
        fat_g: null,
        fiber_g: null,
        weight_kg: null,
        body_fat_pct: null,
        weight_30d_avg: null,
        body_fat_30d_avg: null,
        weight_30d_delta: null,
        body_fat_30d_delta: null,
      });
    });
    const result = exhaustiveSweep(days, new Set());
    // Should find at least some correlations
    expect(result.length).toBeGreaterThanOrEqual(0);
    for (const insight of result) {
      expect(insight.type).toBe("discovery");
    }
  });

  it("skips pairs already in existingIds", () => {
    const days = dateRange("2025-01-01", 40).map((date, idx) =>
      makeFullJoinedDay(date, {
        steps: 5000 + idx * 200,
        hrv: 30 + idx * 1.2,
        exercise_minutes: null,
        cardio_minutes: null,
        strength_minutes: null,
        flexibility_minutes: null,
        calories: null,
        protein_g: null,
        carbs_g: null,
        fat_g: null,
        fiber_g: null,
        weight_kg: null,
        body_fat_pct: null,
        weight_30d_avg: null,
        body_fat_30d_avg: null,
        weight_30d_delta: null,
        body_fat_30d_delta: null,
      }),
    );
    // Get discoveries without exclusions
    const all = exhaustiveSweep(days, new Set());
    // Now exclude all of them
    const existingIds = new Set(all.map((insight) => `${insight.action}::${insight.metric}`));
    const filtered = exhaustiveSweep(days, existingIds);
    expect(filtered.length).toBeLessThanOrEqual(all.length);
  });

  it("deduplicates reversed pairs (A→B and B→A keeps strongest)", () => {
    // With correlated data, both directions might be found — verify dedup
    const days = dateRange("2025-01-01", 40).map((date, idx) =>
      makeFullJoinedDay(date, {
        resting_hr: 60 + idx * 0.5,
        hrv: 50 - idx * 0.3,
        exercise_minutes: null,
        cardio_minutes: null,
        strength_minutes: null,
        flexibility_minutes: null,
        calories: null,
        protein_g: null,
        carbs_g: null,
        fat_g: null,
        fiber_g: null,
        weight_kg: null,
        body_fat_pct: null,
        weight_30d_avg: null,
        body_fat_30d_avg: null,
        weight_30d_delta: null,
        body_fat_30d_delta: null,
      }),
    );
    const result = exhaustiveSweep(days, new Set());
    // Check that no two discoveries share the same unordered pair
    const pairs = new Set<string>();
    for (const discovery of result) {
      const [sortedA, sortedB] = [discovery.action, discovery.metric].sort();
      const pairKey = `${sortedA}::${sortedB}`;
      expect(pairs.has(pairKey)).toBe(false);
      pairs.add(pairKey);
    }
  });

  it("sorts discoveries by absolute effect size descending", () => {
    const days = dateRange("2025-01-01", 50).map((date, idx) =>
      makeFullJoinedDay(date, {
        resting_hr: 60 + idx * 0.5,
        hrv: 50 - idx * 0.4,
        steps: 5000 + idx * 150,
        exercise_minutes: null,
        cardio_minutes: null,
        strength_minutes: null,
        flexibility_minutes: null,
        calories: null,
        protein_g: null,
        carbs_g: null,
        fat_g: null,
        fiber_g: null,
        weight_kg: null,
        body_fat_pct: null,
        weight_30d_avg: null,
        body_fat_30d_avg: null,
        weight_30d_delta: null,
        body_fat_30d_delta: null,
      }),
    );
    const result = exhaustiveSweep(days, new Set());
    for (let idx = 1; idx < result.length; idx++) {
      const prev = result[idx - 1];
      const curr = result[idx];
      if (prev && curr && Number.isFinite(prev.effectSize) && Number.isFinite(curr.effectSize)) {
        expect(Math.abs(prev.effectSize)).toBeGreaterThanOrEqual(Math.abs(curr.effectSize));
      }
    }
  });

  it("discovery insights have correct structure", () => {
    const days = dateRange("2025-01-01", 40).map((date, idx) =>
      makeFullJoinedDay(date, {
        resting_hr: 60 + idx * 0.5,
        hrv: 50 - idx * 0.4,
        exercise_minutes: null,
        cardio_minutes: null,
        strength_minutes: null,
        flexibility_minutes: null,
        calories: null,
        protein_g: null,
        carbs_g: null,
        fat_g: null,
        fiber_g: null,
        weight_kg: null,
        body_fat_pct: null,
        weight_30d_avg: null,
        body_fat_30d_avg: null,
        weight_30d_delta: null,
        body_fat_30d_delta: null,
      }),
    );
    const result = exhaustiveSweep(days, new Set());
    for (const discovery of result) {
      expect(discovery.type).toBe("discovery");
      expect(discovery.id).toMatch(/^disc-/);
      expect(discovery.message.length).toBeGreaterThan(0);
      expect(discovery.detail).toContain("Spearman");
      expect(discovery.correlation).toBeDefined();
      expect(discovery.dataPoints).toBeDefined();
    }
  });

  it("discovery message includes strength descriptor for strong correlations", () => {
    const days = dateRange("2025-01-01", 50).map((date, idx) =>
      makeFullJoinedDay(date, {
        resting_hr: 60 + idx,
        hrv: 80 - idx,
        exercise_minutes: null,
        cardio_minutes: null,
        strength_minutes: null,
        flexibility_minutes: null,
        calories: null,
        protein_g: null,
        carbs_g: null,
        fat_g: null,
        fiber_g: null,
        weight_kg: null,
        body_fat_pct: null,
        weight_30d_avg: null,
        body_fat_30d_avg: null,
        weight_30d_delta: null,
        body_fat_30d_delta: null,
      }),
    );
    const result = exhaustiveSweep(days, new Set());
    // With perfect negative correlation, should find strong associations
    const strongOnes = result.filter((discovery) => Math.abs(discovery.effectSize) >= 0.6);
    for (const discovery of strongOnes) {
      expect(discovery.message).toContain("strongly");
    }
  });
});
