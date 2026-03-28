import { describe, expect, it, vi } from "vitest";
import type { DailyContext } from "../ml/activity-features.ts";
import {
  buildDailyContext,
  PredictionTargetEntry,
  PredictionsRepository,
} from "./predictions-repository.ts";

// ---------------------------------------------------------------------------
// Domain models
// ---------------------------------------------------------------------------

describe("PredictionTargetEntry", () => {
  it("serializes daily target to API shape", () => {
    const entry = new PredictionTargetEntry({
      id: "hrv",
      label: "Heart Rate Variability",
      unit: "ms",
      type: "daily",
    });
    expect(entry.toDetail()).toEqual({
      id: "hrv",
      label: "Heart Rate Variability",
      unit: "ms",
      type: "daily",
    });
  });

  it("serializes activity target to API shape", () => {
    const entry = new PredictionTargetEntry({
      id: "cardio_power",
      label: "Cardio Power Output",
      unit: "W",
      type: "activity",
    });
    expect(entry.toDetail()).toEqual({
      id: "cardio_power",
      label: "Cardio Power Output",
      unit: "W",
      type: "activity",
    });
  });

  it("exposes getters for all fields", () => {
    const entry = new PredictionTargetEntry({
      id: "resting_hr",
      label: "Resting Heart Rate",
      unit: "bpm",
      type: "daily",
    });
    expect(entry.id).toBe("resting_hr");
    expect(entry.label).toBe("Resting Heart Rate");
    expect(entry.unit).toBe("bpm");
    expect(entry.type).toBe("daily");
  });
});

// ---------------------------------------------------------------------------
// buildDailyContext
// ---------------------------------------------------------------------------

describe("buildDailyContext", () => {
  it("returns empty array when no data sources have entries", () => {
    const result = buildDailyContext([], [], [], []);
    expect(result).toEqual([]);
  });

  it("builds context from daily metrics only", () => {
    const metrics = [
      {
        date: "2024-01-15",
        resting_hr: 60,
        hrv: 45,
        spo2_avg: 97,
        steps: 8000,
        active_energy_kcal: 500,
        skin_temp_c: 36.5,
      },
    ];
    const result = buildDailyContext(metrics, [], [], []);
    expect(result).toHaveLength(1);
    expect(result[0]?.hrv).toBe(45);
    expect(result[0]?.restingHr).toBe(60);
    expect(result[0]?.steps).toBe(8000);
    expect(result[0]?.sleepDurationMin).toBeNull();
    expect(result[0]?.calories).toBeNull();
  });

  it("joins sleep data by wake-up date", () => {
    const sleep = [
      {
        started_at: "2024-01-14T22:00:00Z",
        duration_minutes: 480,
        deep_minutes: 90,
        rem_minutes: 100,
        light_minutes: 250,
        awake_minutes: 40,
        efficiency_pct: 92,
        is_nap: false,
      },
    ];
    // Wake-up: 2024-01-14T22:00 + 480min = 2024-01-15T06:00
    const result = buildDailyContext([], sleep, [], []);
    expect(result).toHaveLength(1);
    expect(result[0]?.date).toBe("2024-01-15");
    expect(result[0]?.sleepDurationMin).toBe(480);
    expect(result[0]?.deepMin).toBe(90);
    expect(result[0]?.sleepEfficiency).toBe(92);
  });

  it("excludes naps from sleep data", () => {
    const sleep = [
      {
        started_at: "2024-01-15T14:00:00Z",
        duration_minutes: 30,
        deep_minutes: 10,
        rem_minutes: 5,
        light_minutes: 10,
        awake_minutes: 5,
        efficiency_pct: 85,
        is_nap: true,
      },
    ];
    const result = buildDailyContext([], sleep, [], []);
    expect(result).toEqual([]);
  });

  it("joins nutrition data by date", () => {
    const nutrition = [
      {
        date: "2024-01-15",
        calories: 2200,
        protein_g: 150,
        carbs_g: 250,
        fat_g: 80,
        fiber_g: 30,
        water_ml: 2500,
      },
    ];
    const result = buildDailyContext([], [], nutrition, []);
    expect(result).toHaveLength(1);
    expect(result[0]?.calories).toBe(2200);
    expect(result[0]?.proteinG).toBe(150);
  });

  it("carries forward last known weight", () => {
    const metrics = [
      {
        date: "2024-01-15",
        resting_hr: 60,
        hrv: 45,
        spo2_avg: null,
        steps: null,
        active_energy_kcal: null,
        skin_temp_c: null,
      },
      {
        date: "2024-01-16",
        resting_hr: 62,
        hrv: 42,
        spo2_avg: null,
        steps: null,
        active_energy_kcal: null,
        skin_temp_c: null,
      },
    ];
    const bodyComp = [
      { recorded_at: "2024-01-15T08:00:00Z", weight_kg: 75.5, body_fat_pct: 15 },
    ];
    const result = buildDailyContext(metrics, [], [], bodyComp);
    expect(result).toHaveLength(2);
    expect(result[0]?.weightKg).toBe(75.5);
    // Weight carries forward to the next day
    expect(result[1]?.weightKg).toBe(75.5);
  });

  it("includes exercise minutes from activity data", () => {
    const metrics = [
      {
        date: "2024-01-15",
        resting_hr: 60,
        hrv: 45,
        spo2_avg: null,
        steps: null,
        active_energy_kcal: null,
        skin_temp_c: null,
      },
    ];
    const exerciseMinutes = [{ date: "2024-01-15", exercise_minutes: 45 }];
    const result = buildDailyContext(metrics, [], [], [], exerciseMinutes);
    expect(result).toHaveLength(1);
    expect(result[0]?.exerciseMinutes).toBe(45);
  });

  it("handles Date objects for date fields", () => {
    const metrics = [
      {
        date: new Date("2024-01-15"),
        resting_hr: 60,
        hrv: 45,
        spo2_avg: null,
        steps: null,
        active_energy_kcal: null,
        skin_temp_c: null,
      },
    ];
    const result = buildDailyContext(metrics, [], [], []);
    expect(result).toHaveLength(1);
    expect(result[0]?.date).toBe("2024-01-15");
  });

  it("merges multiple data sources on the same date", () => {
    const metrics = [
      {
        date: "2024-01-15",
        resting_hr: 60,
        hrv: 45,
        spo2_avg: 97,
        steps: 8000,
        active_energy_kcal: 500,
        skin_temp_c: 36.5,
      },
    ];
    const sleep = [
      {
        started_at: "2024-01-14T22:00:00Z",
        duration_minutes: 480,
        deep_minutes: 90,
        rem_minutes: 100,
        light_minutes: 250,
        awake_minutes: 40,
        efficiency_pct: 92,
        is_nap: false,
      },
    ];
    const nutrition = [
      {
        date: "2024-01-15",
        calories: 2200,
        protein_g: 150,
        carbs_g: 250,
        fat_g: 80,
        fiber_g: 30,
        water_ml: 2500,
      },
    ];
    const result = buildDailyContext(metrics, sleep, nutrition, []);
    expect(result).toHaveLength(1);
    const day = result[0] as DailyContext;
    expect(day.hrv).toBe(45);
    expect(day.sleepDurationMin).toBe(480);
    expect(day.calories).toBe(2200);
  });

  it("sorts output by date", () => {
    const metrics = [
      {
        date: "2024-01-17",
        resting_hr: 62,
        hrv: 42,
        spo2_avg: null,
        steps: null,
        active_energy_kcal: null,
        skin_temp_c: null,
      },
      {
        date: "2024-01-15",
        resting_hr: 60,
        hrv: 45,
        spo2_avg: null,
        steps: null,
        active_energy_kcal: null,
        skin_temp_c: null,
      },
    ];
    const result = buildDailyContext(metrics, [], [], []);
    expect(result[0]?.date).toBe("2024-01-15");
    expect(result[1]?.date).toBe("2024-01-17");
  });
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

describe("PredictionsRepository", () => {
  function makeRepository(rows: Record<string, unknown>[] = []) {
    const execute = vi.fn().mockResolvedValue(rows);
    const db = { execute };
    const repo = new PredictionsRepository(db, "user-1", "UTC");
    return { repo, execute };
  }

  describe("getTargets", () => {
    it("returns all prediction targets", () => {
      const { repo } = makeRepository();
      const targets = repo.getTargets();
      expect(targets.length).toBeGreaterThan(0);
      // Should include both daily and activity targets
      const types = new Set(targets.map((target) => target.type));
      expect(types.has("daily")).toBe(true);
      expect(types.has("activity")).toBe(true);
    });

    it("returns PredictionTargetEntry instances", () => {
      const { repo } = makeRepository();
      const targets = repo.getTargets();
      for (const target of targets) {
        expect(target).toBeInstanceOf(PredictionTargetEntry);
      }
    });

    it("includes HRV as a daily target", () => {
      const { repo } = makeRepository();
      const targets = repo.getTargets();
      const hrv = targets.find((target) => target.id === "hrv");
      expect(hrv).toBeDefined();
      expect(hrv?.type).toBe("daily");
      expect(hrv?.unit).toBe("ms");
    });

    it("includes cardio power as an activity target", () => {
      const { repo } = makeRepository();
      const targets = repo.getTargets();
      const cardioPower = targets.find((target) => target.id === "cardio_power");
      expect(cardioPower).toBeDefined();
      expect(cardioPower?.type).toBe("activity");
      expect(cardioPower?.unit).toBe("W");
    });

    it("serializes targets via toDetail()", () => {
      const { repo } = makeRepository();
      const targets = repo.getTargets();
      const details = targets.map((target) => target.toDetail());
      for (const detail of details) {
        expect(detail).toHaveProperty("id");
        expect(detail).toHaveProperty("label");
        expect(detail).toHaveProperty("unit");
        expect(detail).toHaveProperty("type");
      }
    });
  });

  describe("predict", () => {
    it("returns null for unknown target", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.predict("nonexistent_target", 365);
      expect(result).toBeNull();
    });

    it("calls db.execute for daily predictions", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.predict("hrv", 365);
      // Daily prediction fetches 5 data sources in parallel
      expect(execute).toHaveBeenCalled();
    });

    it("calls db.execute for activity predictions", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.predict("cardio_power", 365);
      // Activity prediction fetches multiple data sources
      expect(execute).toHaveBeenCalled();
    });
  });
});
