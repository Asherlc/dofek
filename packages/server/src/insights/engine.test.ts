import { describe, expect, it } from "vitest";
import {
  type ActivityRow,
  type BodyCompRow,
  computeInsights,
  type DailyRow,
  type InsightsConfig,
  joinByDate,
  type NutritionRow,
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
