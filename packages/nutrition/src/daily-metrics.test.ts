import { describe, expect, it } from "vitest";
import {
  DAILY_METRIC_TYPES,
  type DailyMetricCategory,
  getDailyMetricTypeById,
  getDailyMetricTypeByLegacyField,
  legacyFieldsToDailyMetrics,
} from "./daily-metrics.ts";

describe("DAILY_METRIC_TYPES catalog", () => {
  it("has unique ids", () => {
    const ids = DAILY_METRIC_TYPES.map((type) => type.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has unique legacy field names", () => {
    const fields = DAILY_METRIC_TYPES.map((type) => type.legacyFieldName);
    expect(new Set(fields).size).toBe(fields.length);
  });

  it("has unique legacy column names", () => {
    const columns = DAILY_METRIC_TYPES.map((type) => type.legacyColumnName);
    expect(new Set(columns).size).toBe(columns.length);
  });

  it("every type has a non-empty display name and unit", () => {
    for (const type of DAILY_METRIC_TYPES) {
      expect(type.displayName.length).toBeGreaterThan(0);
    }
  });

  it("every type has a valid category", () => {
    const validCategories: DailyMetricCategory[] = [
      "recovery",
      "activity",
      "gait",
      "audio",
      "stress",
      "other",
    ];
    for (const type of DAILY_METRIC_TYPES) {
      expect(validCategories).toContain(type.category);
    }
  });

  it("every type has a valid priority category", () => {
    for (const type of DAILY_METRIC_TYPES) {
      expect(["recovery", "activity"]).toContain(type.priorityCategory);
    }
  });

  it("includes all original daily_metrics columns", () => {
    const ids = DAILY_METRIC_TYPES.map((type) => type.id);
    expect(ids).toContain("resting_hr");
    expect(ids).toContain("hrv");
    expect(ids).toContain("vo2max");
    expect(ids).toContain("spo2_avg");
    expect(ids).toContain("steps");
    expect(ids).toContain("active_energy_kcal");
    expect(ids).toContain("distance_km");
    expect(ids).toContain("walking_speed");
    expect(ids).toContain("skin_temp_c");
    expect(ids).toContain("exercise_minutes");
  });

  it("recovery metrics use recovery priority", () => {
    const hrv = getDailyMetricTypeById("hrv");
    expect(hrv?.priorityCategory).toBe("recovery");

    const skinTemp = getDailyMetricTypeById("skin_temp_c");
    expect(skinTemp?.priorityCategory).toBe("recovery");
  });

  it("activity metrics use activity priority", () => {
    const steps = getDailyMetricTypeById("steps");
    expect(steps?.priorityCategory).toBe("activity");

    const walkingSpeed = getDailyMetricTypeById("walking_speed");
    expect(walkingSpeed?.priorityCategory).toBe("activity");
  });
});

describe("getDailyMetricTypeById", () => {
  it("returns the type for a valid id", () => {
    const result = getDailyMetricTypeById("resting_hr");
    expect(result).not.toBeNull();
    expect(result?.displayName).toBe("Resting Heart Rate");
    expect(result?.unit).toBe("bpm");
  });

  it("returns null for unknown id", () => {
    expect(getDailyMetricTypeById("nonexistent")).toBeNull();
  });
});

describe("getDailyMetricTypeByLegacyField", () => {
  it("maps camelCase field name to type", () => {
    const result = getDailyMetricTypeByLegacyField("activeEnergyKcal");
    expect(result?.id).toBe("active_energy_kcal");
  });
});

describe("legacyFieldsToDailyMetrics", () => {
  it("converts legacy fields to metric id map", () => {
    const result = legacyFieldsToDailyMetrics({
      restingHr: 58,
      steps: 8200,
      hrv: 42.5,
    });
    expect(result).toEqual({
      resting_hr: 58,
      steps: 8200,
      hrv: 42.5,
    });
  });

  it("skips null, non-number values, and non-metric fields", () => {
    const result = legacyFieldsToDailyMetrics({
      restingHr: 58,
      hrv: null,
      sourceName: "Apple Watch",
      resilienceLevel: "solid",
    });
    expect(result).toEqual({ resting_hr: 58 });
  });
});
