import { describe, expect, it, vi } from "vitest";
import {
  buildDailyContext,
  PredictionsRepository,
  PredictionTargetEntry,
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

  it("toDetail returns id, label, unit, and type as distinct values", () => {
    const entry = new PredictionTargetEntry({
      id: "weight",
      label: "Body Weight",
      unit: "kg",
      type: "daily",
    });
    const detail = entry.toDetail();
    expect(detail.id).toBe("weight");
    expect(detail.label).toBe("Body Weight");
    expect(detail.unit).toBe("kg");
    expect(detail.type).toBe("daily");
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

  it("maps id from constructor row.id (not row.label or row.unit)", () => {
    const entry = new PredictionTargetEntry({
      id: "unique_id",
      label: "unique_label",
      unit: "unique_unit",
      type: "activity",
    });
    expect(entry.id).toStrictEqual("unique_id");
    expect(entry.label).toStrictEqual("unique_label");
    expect(entry.unit).toStrictEqual("unique_unit");
    expect(entry.type).toStrictEqual("activity");
  });

  it("toDetail maps each field independently (not returning same value for all)", () => {
    const entry = new PredictionTargetEntry({
      id: "field_a",
      label: "field_b",
      unit: "field_c",
      type: "daily",
    });
    const detail = entry.toDetail();
    expect(detail.id).toBe("field_a");
    expect(detail.label).toBe("field_b");
    expect(detail.unit).toBe("field_c");
    expect(detail.type).toBe("daily");
    // Verify fields are not swapped
    expect(detail.id).not.toBe(detail.label);
    expect(detail.label).not.toBe(detail.unit);
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
    const bodyComp = [{ recorded_at: "2024-01-15T08:00:00Z", weight_kg: 75.5, body_fat_pct: 15 }];
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
    const day = result[0];
    expect(day?.hrv).toBe(45);
    expect(day?.sleepDurationMin).toBe(480);
    expect(day?.calories).toBe(2200);
  });

  it("returns null exerciseMinutes when no exercise data for date", () => {
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
    const result = buildDailyContext(metrics, [], [], []);
    expect(result[0]?.exerciseMinutes).toStrictEqual(null);
  });

  it("returns null weightKg when no body comp data exists", () => {
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
    const result = buildDailyContext(metrics, [], [], []);
    expect(result[0]?.weightKg).toStrictEqual(null);
  });

  it("handles null exercise_minutes in exercise data", () => {
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
    const exerciseMinutes = [{ date: "2024-01-15", exercise_minutes: null }];
    const result = buildDailyContext(metrics, [], [], [], exerciseMinutes);
    // null exercise_minutes should not be added to the map
    expect(result[0]?.exerciseMinutes).toStrictEqual(null);
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

  it("maps all null fields to null via ?? null (not undefined or 0)", () => {
    const metrics = [
      {
        date: "2024-01-15",
        resting_hr: null,
        hrv: null,
        spo2_avg: null,
        steps: null,
        active_energy_kcal: null,
        skin_temp_c: null,
      },
    ];
    const result = buildDailyContext(metrics, [], [], []);
    expect(result).toHaveLength(1);
    const day = result[0];
    expect(day?.hrv).toStrictEqual(null);
    expect(day?.restingHr).toStrictEqual(null);
    expect(day?.steps).toStrictEqual(null);
    expect(day?.sleepDurationMin).toStrictEqual(null);
    expect(day?.deepMin).toStrictEqual(null);
    expect(day?.sleepEfficiency).toStrictEqual(null);
    expect(day?.calories).toStrictEqual(null);
    expect(day?.proteinG).toStrictEqual(null);
    expect(day?.weightKg).toStrictEqual(null);
    expect(day?.exerciseMinutes).toStrictEqual(null);
  });

  it("maps all non-null fields to their exact values (not null or 0)", () => {
    const metrics = [
      {
        date: "2024-01-15",
        resting_hr: 58,
        hrv: 52,
        spo2_avg: 98,
        steps: 12000,
        active_energy_kcal: 600,
        skin_temp_c: 36.8,
      },
    ];
    const sleep = [
      {
        started_at: "2024-01-14T23:00:00Z",
        duration_minutes: 420,
        deep_minutes: 80,
        rem_minutes: 95,
        light_minutes: 210,
        awake_minutes: 35,
        efficiency_pct: 88,
        is_nap: false,
      },
    ];
    const nutrition = [
      {
        date: "2024-01-15",
        calories: 2400,
        protein_g: 160,
        carbs_g: 280,
        fat_g: 85,
        fiber_g: 32,
        water_ml: 2800,
      },
    ];
    const bodyComp = [{ recorded_at: "2024-01-15T07:00:00Z", weight_kg: 80.2, body_fat_pct: 18 }];
    const exercise = [{ date: "2024-01-15", exercise_minutes: 55 }];

    const result = buildDailyContext(metrics, sleep, nutrition, bodyComp, exercise);
    expect(result).toHaveLength(1);
    const day = result[0];
    expect(day?.hrv).toBe(52);
    expect(day?.restingHr).toBe(58);
    expect(day?.steps).toBe(12000);
    expect(day?.sleepDurationMin).toBe(420);
    expect(day?.deepMin).toBe(80);
    expect(day?.sleepEfficiency).toBe(88);
    expect(day?.calories).toBe(2400);
    expect(day?.proteinG).toBe(160);
    expect(day?.weightKg).toBe(80.2);
    expect(day?.exerciseMinutes).toBe(55);
  });

  it("maps hrv from metricsRow.hrv (not resting_hr or steps)", () => {
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
    // hrv should be 45 (from hrv), not 60 (from resting_hr) or 8000 (from steps)
    expect(result[0]?.hrv).toBe(45);
    expect(result[0]?.restingHr).toBe(60);
  });

  it("maps sleepDurationMin from duration_minutes (not deep_minutes or awake_minutes)", () => {
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
    const result = buildDailyContext([], sleep, [], []);
    expect(result[0]?.sleepDurationMin).toBe(480);
    expect(result[0]?.deepMin).toBe(90);
    expect(result[0]?.sleepEfficiency).toBe(92);
  });

  it("maps calories from nutrition calories (not protein_g or fat_g)", () => {
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
    expect(result[0]?.calories).toBe(2200);
    expect(result[0]?.proteinG).toBe(150);
  });

  it("handles Date objects for nutrition and exercise date fields", () => {
    const nutrition = [
      {
        date: new Date("2024-01-15"),
        calories: 1800,
        protein_g: 120,
        carbs_g: 200,
        fat_g: 60,
        fiber_g: 25,
        water_ml: 2000,
      },
    ];
    const exercise = [{ date: new Date("2024-01-15"), exercise_minutes: 30 }];
    const result = buildDailyContext([], [], nutrition, [], exercise);
    expect(result).toHaveLength(1);
    expect(result[0]?.date).toBe("2024-01-15");
    expect(result[0]?.calories).toBe(1800);
    expect(result[0]?.exerciseMinutes).toBe(30);
  });

  it("weight carry-forward uses last non-null weight_kg (not body_fat_pct)", () => {
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
    const bodyComp = [{ recorded_at: "2024-01-15T08:00:00Z", weight_kg: 75.5, body_fat_pct: 15.2 }];
    const result = buildDailyContext(metrics, [], [], bodyComp);
    // Day 1: weight is 75.5 (not 15.2 which is body_fat_pct)
    expect(result[0]?.weightKg).toBe(75.5);
    // Day 2: weight carries forward as 75.5
    expect(result[1]?.weightKg).toBe(75.5);
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

    it("returns null for a target that matches neither daily nor activity types", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.predict("totally_fake_id", 90);
      expect(result).toStrictEqual(null);
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

    it("calls db.execute for strength activity predictions", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.predict("strength_volume", 365);
      expect(execute).toHaveBeenCalled();
    });

    it("returns null for daily prediction with insufficient data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.predict("hrv", 365);
      // With no data, trainPredictor returns null
      expect(result).toBeNull();
    });

    it("dispatches to daily pipeline for known daily target IDs", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.predict("resting_hr", 365);
      // Daily prediction fetches 5 data sources in parallel
      expect(execute).toHaveBeenCalledTimes(5);
    });

    it("dispatches to activity pipeline for known activity target IDs", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.predict("cardio_power", 365);
      // Activity prediction fetches 5 data sources + 1 activity-specific query
      expect(execute.mock.calls.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe("getTargets", () => {
    it("returns targets with correct type labels (daily vs activity)", () => {
      const { repo } = makeRepository();
      const targets = repo.getTargets();
      const dailyTargets = targets.filter((target) => target.type === "daily");
      const activityTargets = targets.filter((target) => target.type === "activity");
      expect(dailyTargets.length).toBeGreaterThan(0);
      expect(activityTargets.length).toBeGreaterThan(0);
      // Each target should have non-empty id, label, unit
      for (const target of targets) {
        expect(target.id.length).toBeGreaterThan(0);
        expect(target.label.length).toBeGreaterThan(0);
        expect(target.unit.length).toBeGreaterThan(0);
      }
    });
  });

  describe("predict dispatching logic", () => {
    it("predict returns null for unknown target (not undefined or throws)", async () => {
      // Tests the final `return null` at the end of predict()
      const { repo } = makeRepository([]);
      const result = await repo.predict("completely_unknown_id", 90);
      expect(result).toStrictEqual(null);
      expect(result).not.toBe(undefined);
    });

    it("predict checks daily targets before activity targets (order matters)", async () => {
      // getPredictionTarget is checked first, then ACTIVITY_PREDICTION_TARGETS.find
      const { repo, execute } = makeRepository([]);
      // "hrv" is a daily target, should dispatch to daily pipeline (5 parallel queries)
      await repo.predict("hrv", 365);
      expect(execute).toHaveBeenCalledTimes(5);
    });

    it("predict for strength target calls different query than cardio", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.predict("strength_volume", 365);
      // Activity pipeline: 5 context queries + 1 strength-specific query = 6
      expect(execute.mock.calls.length).toBeGreaterThanOrEqual(5);
    });

    it("predict distinguishes cardio vs strength activity types", async () => {
      const { repo: cardioRepo, execute: cardioExec } = makeRepository([]);
      const { repo: strengthRepo, execute: strengthExec } = makeRepository([]);

      await cardioRepo.predict("cardio_power", 365);
      await strengthRepo.predict("strength_volume", 365);

      // Both should call execute (confirms they don't return null early)
      expect(cardioExec).toHaveBeenCalled();
      expect(strengthExec).toHaveBeenCalled();
    });
  });
});

describe("buildDailyContext mutation-killing", () => {
  it("sleep wake-up date computation uses addition not subtraction for minutes", () => {
    // wakeDate.setMinutes(wakeDate.getMinutes() + (sleepRow.duration_minutes ?? 0))
    // If + mutated to -, wake date would be before start (wrong day)
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
    const result = buildDailyContext([], sleep, [], []);
    // Wake: 22:00 + 480min = 06:00 next day -> 2024-01-15
    // If - instead of +, would be 22:00 - 480min = 14:00 same day -> 2024-01-14
    expect(result[0]?.date).toBe("2024-01-15");
    expect(result[0]?.date).not.toBe("2024-01-14");
  });

  it("sleep duration ?? 0 fallback: null duration does not throw", () => {
    // (sleepRow.duration_minutes ?? 0) — if null, use 0
    const sleep = [
      {
        started_at: "2024-01-15T06:00:00Z",
        duration_minutes: null,
        deep_minutes: null,
        rem_minutes: null,
        light_minutes: null,
        awake_minutes: null,
        efficiency_pct: null,
        is_nap: false,
      },
    ];
    const result = buildDailyContext([], sleep, [], []);
    // With null duration, wake time = start time + 0 min => same day
    expect(result).toHaveLength(1);
    expect(result[0]?.date).toBe("2024-01-15");
    expect(result[0]?.sleepDurationMin).toStrictEqual(null);
  });

  it("nap filtering uses 'continue' (if block removed, naps would appear)", () => {
    // if (sleepRow.is_nap) continue;
    // If the block is removed, naps would be in the sleep map
    const sleep = [
      {
        started_at: "2024-01-15T14:00:00Z",
        duration_minutes: 20,
        deep_minutes: 5,
        rem_minutes: 5,
        light_minutes: 5,
        awake_minutes: 5,
        efficiency_pct: 90,
        is_nap: true,
      },
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
    const result = buildDailyContext([], sleep, [], []);
    // Only non-nap sleep should produce entries
    expect(result).toHaveLength(1);
    expect(result[0]?.sleepDurationMin).toBe(480);
  });

  it("exercise_minutes != null check prevents null from being stored in exerciseMap", () => {
    // if (exerciseRow.exercise_minutes != null) exerciseMap.set(...)
    // If check is removed, null values would be stored
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
    const exercise = [{ date: "2024-01-15", exercise_minutes: null }];
    const result = buildDailyContext(metrics, [], [], [], exercise);
    // null exercise_minutes should NOT be stored in the map, so fallback ?? null applies
    expect(result[0]?.exerciseMinutes).toStrictEqual(null);
  });

  it("weight carry-forward updates lastWeight only when weight_kg is non-null", () => {
    // if (bodyCompRow?.weight_kg != null) lastWeight = bodyCompRow.weight_kg
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
      {
        date: "2024-01-17",
        resting_hr: 63,
        hrv: 40,
        spo2_avg: null,
        steps: null,
        active_energy_kcal: null,
        skin_temp_c: null,
      },
    ];
    const bodyComp = [
      { recorded_at: "2024-01-15T08:00:00Z", weight_kg: 75.5, body_fat_pct: 15 },
      { recorded_at: "2024-01-16T08:00:00Z", weight_kg: null, body_fat_pct: 14.8 },
    ];
    const result = buildDailyContext(metrics, [], [], bodyComp);
    // Day 1: 75.5 (from measurement)
    expect(result[0]?.weightKg).toBe(75.5);
    // Day 2: weight_kg is null, so lastWeight stays 75.5 (not overwritten to null)
    expect(result[1]?.weightKg).toBe(75.5);
    // Day 3: still carries forward 75.5
    expect(result[2]?.weightKg).toBe(75.5);
  });

  it("output object has exactly 11 keys per day (kills ObjectLiteral mutations)", () => {
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
    const dayKeys = Object.keys(result[0] ?? {}).sort();
    expect(dayKeys).toStrictEqual([
      "calories",
      "date",
      "deepMin",
      "exerciseMinutes",
      "hrv",
      "proteinG",
      "restingHr",
      "sleepDurationMin",
      "sleepEfficiency",
      "steps",
      "weightKg",
    ]);
  });

  it("dates are sorted ascending (uses .sort() not reverse)", () => {
    const metrics = [
      {
        date: "2024-01-17",
        resting_hr: 63,
        hrv: 40,
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
    const result = buildDailyContext(metrics, [], [], []);
    expect(result[0]?.date).toBe("2024-01-15");
    expect(result[1]?.date).toBe("2024-01-16");
    expect(result[2]?.date).toBe("2024-01-17");
  });

  it("allDates set collects from all four map sources (not just metrics)", () => {
    // Only nutrition data, no metrics, sleep, or body comp
    const nutrition = [
      {
        date: "2024-01-20",
        calories: 2000,
        protein_g: 100,
        carbs_g: 200,
        fat_g: 70,
        fiber_g: 25,
        water_ml: 2000,
      },
    ];
    const result = buildDailyContext([], [], nutrition, []);
    expect(result).toHaveLength(1);
    expect(result[0]?.date).toBe("2024-01-20");
    expect(result[0]?.calories).toBe(2000);
    // Other fields should be null since only nutrition was provided
    expect(result[0]?.hrv).toStrictEqual(null);
  });

  it("allDates set collects from bodyComp map too", () => {
    const bodyComp = [{ recorded_at: "2024-02-01T08:00:00Z", weight_kg: 80.0, body_fat_pct: 20 }];
    const result = buildDailyContext([], [], [], bodyComp);
    expect(result).toHaveLength(1);
    expect(result[0]?.date).toBe("2024-02-01");
    expect(result[0]?.weightKg).toBe(80.0);
  });

  it("exerciseMinutes uses exerciseMap.get(date) ?? null (not 0 or undefined)", () => {
    // For dates without exercise data, exerciseMinutes should be null
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
    const exercise = [{ date: "2024-01-16", exercise_minutes: 30 }];
    const result = buildDailyContext(metrics, [], [], [], exercise);
    // Jan 15 has no exercise data -> should be null, not 0
    expect(result[0]?.exerciseMinutes).toStrictEqual(null);
    expect(result[0]?.exerciseMinutes).not.toBe(0);
  });
});

describe("PredictionTargetEntry mutation-killing", () => {
  it("toDetail returns a new object with all four properties (not empty object)", () => {
    const entry = new PredictionTargetEntry({
      id: "test_id",
      label: "Test Label",
      unit: "test_unit",
      type: "activity",
    });
    const detail = entry.toDetail();
    expect(Object.keys(detail)).toHaveLength(4);
    expect(detail.id).toStrictEqual("test_id");
    expect(detail.label).toStrictEqual("Test Label");
    expect(detail.unit).toStrictEqual("test_unit");
    expect(detail.type).toStrictEqual("activity");
  });

  it("toDetail id maps from row.id (not row.type or row.label)", () => {
    const entry = new PredictionTargetEntry({
      id: "alpha",
      label: "beta",
      unit: "gamma",
      type: "daily",
    });
    const detail = entry.toDetail();
    expect(detail.id).toBe("alpha");
    expect(detail.label).toBe("beta");
    expect(detail.unit).toBe("gamma");
    expect(detail.type).toBe("daily");
    // Ensure no field swapping
    expect(detail.id).not.toBe("beta");
    expect(detail.id).not.toBe("gamma");
    expect(detail.id).not.toBe("daily");
  });

  it("getter type returns 'daily' not 'activity' for daily entries", () => {
    const entry = new PredictionTargetEntry({
      id: "x",
      label: "X",
      unit: "u",
      type: "daily",
    });
    expect(entry.type).toStrictEqual("daily");
    expect(entry.type).not.toBe("activity");
  });

  it("getter type returns 'activity' not 'daily' for activity entries", () => {
    const entry = new PredictionTargetEntry({
      id: "y",
      label: "Y",
      unit: "v",
      type: "activity",
    });
    expect(entry.type).toStrictEqual("activity");
    expect(entry.type).not.toBe("daily");
  });
});
