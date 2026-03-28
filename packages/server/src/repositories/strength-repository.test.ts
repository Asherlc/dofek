import { describe, expect, it, vi } from "vitest";
import {
  EstimatedOneRepMax,
  linearRegressionSlope,
  MuscleGroupVolume,
  ProgressiveOverload,
  StrengthRepository,
  VolumeWeek,
  WorkoutSummary,
} from "./strength-repository.ts";

// ---------------------------------------------------------------------------
// Domain models
// ---------------------------------------------------------------------------

describe("VolumeWeek", () => {
  it("serializes to API shape", () => {
    const week = new VolumeWeek({
      week: "2024-01-15",
      totalVolumeKg: 12500,
      setCount: 45,
      workoutCount: 3,
    });
    expect(week.toDetail()).toEqual({
      week: "2024-01-15",
      totalVolumeKg: 12500,
      setCount: 45,
      workoutCount: 3,
    });
  });
});

describe("EstimatedOneRepMax", () => {
  it("groups history under exercise name", () => {
    const entry = new EstimatedOneRepMax("Bench Press", [
      { date: "2024-01-01", estimatedMax: 100, actualWeight: 80, actualReps: 8 },
      { date: "2024-01-15", estimatedMax: 105, actualWeight: 85, actualReps: 7 },
    ]);
    const detail = entry.toDetail();
    expect(detail.exerciseName).toBe("Bench Press");
    expect(detail.history).toHaveLength(2);
    expect(detail.history[0]?.estimatedMax).toBe(100);
  });

  it("handles single entry", () => {
    const entry = new EstimatedOneRepMax("Squat", [
      { date: "2024-01-01", estimatedMax: 150, actualWeight: 120, actualReps: 5 },
    ]);
    expect(entry.toDetail().history).toHaveLength(1);
  });
});

describe("MuscleGroupVolume", () => {
  it("serializes muscle group with weekly data", () => {
    const volume = new MuscleGroupVolume("chest", [
      { week: "2024-01-08", sets: 12 },
      { week: "2024-01-15", sets: 15 },
    ]);
    const detail = volume.toDetail();
    expect(detail.muscleGroup).toBe("chest");
    expect(detail.weeklyData).toHaveLength(2);
    expect(detail.weeklyData[0]?.sets).toBe(12);
  });
});

describe("ProgressiveOverload", () => {
  it("computes positive slope for increasing volumes", () => {
    const overload = new ProgressiveOverload("Deadlift", [1000, 1100, 1200, 1300]);
    const detail = overload.toDetail();
    expect(detail.exerciseName).toBe("Deadlift");
    expect(detail.slopeKgPerWeek).toBeGreaterThan(0);
    expect(detail.isProgressing).toBe(true);
  });

  it("computes negative slope for decreasing volumes", () => {
    const overload = new ProgressiveOverload("Curls", [500, 400, 300, 200]);
    const detail = overload.toDetail();
    expect(detail.slopeKgPerWeek).toBeLessThan(0);
    expect(detail.isProgressing).toBe(false);
  });

  it("returns zero slope for flat volumes", () => {
    const overload = new ProgressiveOverload("Rows", [500, 500, 500]);
    expect(overload.slopeKgPerWeek).toBe(0);
    expect(overload.isProgressing).toBe(false);
  });

  it("includes weekly volumes in detail", () => {
    const volumes = [1000, 1100, 1200];
    const overload = new ProgressiveOverload("Squat", volumes);
    expect(overload.toDetail().weeklyVolumes).toEqual(volumes);
  });
});

describe("WorkoutSummary", () => {
  it("serializes to API shape", () => {
    const summary = new WorkoutSummary({
      date: "2024-01-15",
      name: "Upper Body",
      exerciseCount: 5,
      totalSets: 20,
      totalVolumeKg: 3500,
      durationMinutes: 65,
    });
    expect(summary.toDetail()).toEqual({
      date: "2024-01-15",
      name: "Upper Body",
      exerciseCount: 5,
      totalSets: 20,
      totalVolumeKg: 3500,
      durationMinutes: 65,
    });
  });
});

// ---------------------------------------------------------------------------
// linearRegressionSlope
// ---------------------------------------------------------------------------

describe("linearRegressionSlope", () => {
  it("returns 0 for fewer than 2 values", () => {
    expect(linearRegressionSlope([])).toBe(0);
    expect(linearRegressionSlope([100])).toBe(0);
  });

  it("computes positive slope for increasing series", () => {
    expect(linearRegressionSlope([100, 200, 300])).toBeCloseTo(100, 5);
  });

  it("computes negative slope for decreasing series", () => {
    expect(linearRegressionSlope([300, 200, 100])).toBeCloseTo(-100, 5);
  });

  it("returns 0 for constant series", () => {
    expect(linearRegressionSlope([50, 50, 50, 50])).toBeCloseTo(0, 5);
  });
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

describe("StrengthRepository", () => {
  function makeRepository(rows: Record<string, unknown>[] = []) {
    const execute = vi.fn().mockResolvedValue(rows);
    const db = { execute };
    const repo = new StrengthRepository(db, "user-1", "UTC");
    return { repo, execute };
  }

  describe("getVolumeOverTime", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getVolumeOverTime(90);
      expect(result).toEqual([]);
    });

    it("returns VolumeWeek instances", async () => {
      const { repo } = makeRepository([
        { week: "2024-01-15", total_volume_kg: 12500, set_count: 45, workout_count: 3 },
      ]);
      const result = await repo.getVolumeOverTime(90);
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(VolumeWeek);
      expect(result[0]?.toDetail().totalVolumeKg).toBe(12500);
    });

    it("calls execute once", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.getVolumeOverTime(30);
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("getEstimatedOneRepMax", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getEstimatedOneRepMax(90);
      expect(result).toEqual([]);
    });

    it("returns EstimatedOneRepMax instances grouped by exercise", async () => {
      const { repo } = makeRepository([
        {
          exercise_name: "Bench Press",
          workout_date: "2024-01-01",
          estimated_max: 100,
          actual_weight: 80,
          actual_reps: 8,
        },
        {
          exercise_name: "Bench Press",
          workout_date: "2024-01-15",
          estimated_max: 105,
          actual_weight: 85,
          actual_reps: 7,
        },
        {
          exercise_name: "Squat",
          workout_date: "2024-01-01",
          estimated_max: 150,
          actual_weight: 120,
          actual_reps: 5,
        },
      ]);
      const result = await repo.getEstimatedOneRepMax(90);
      expect(result).toHaveLength(2);
      expect(result[0]).toBeInstanceOf(EstimatedOneRepMax);
      expect(result[0]?.toDetail().exerciseName).toBe("Bench Press");
      expect(result[0]?.toDetail().history).toHaveLength(2);
      expect(result[1]?.toDetail().exerciseName).toBe("Squat");
      expect(result[1]?.toDetail().history).toHaveLength(1);
    });
  });

  describe("getMuscleGroupVolume", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getMuscleGroupVolume(90);
      expect(result).toEqual([]);
    });

    it("returns MuscleGroupVolume instances grouped by muscle group", async () => {
      const { repo } = makeRepository([
        { muscle_group: "chest", week: "2024-01-08", sets: 12 },
        { muscle_group: "chest", week: "2024-01-15", sets: 15 },
        { muscle_group: "back", week: "2024-01-08", sets: 10 },
      ]);
      const result = await repo.getMuscleGroupVolume(90);
      expect(result).toHaveLength(2);
      expect(result[0]).toBeInstanceOf(MuscleGroupVolume);
      expect(result[0]?.toDetail().muscleGroup).toBe("chest");
      expect(result[0]?.toDetail().weeklyData).toHaveLength(2);
    });
  });

  describe("getProgressiveOverload", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getProgressiveOverload(90);
      expect(result).toEqual([]);
    });

    it("filters out exercises with fewer than 2 weeks", async () => {
      const { repo } = makeRepository([
        { exercise_name: "Curls", week: "2024-01-08", weekly_volume: 500 },
      ]);
      const result = await repo.getProgressiveOverload(90);
      expect(result).toEqual([]);
    });

    it("returns ProgressiveOverload instances for qualifying exercises", async () => {
      const { repo } = makeRepository([
        { exercise_name: "Deadlift", week: "2024-01-08", weekly_volume: 1000 },
        { exercise_name: "Deadlift", week: "2024-01-15", weekly_volume: 1100 },
        { exercise_name: "Deadlift", week: "2024-01-22", weekly_volume: 1200 },
      ]);
      const result = await repo.getProgressiveOverload(90);
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(ProgressiveOverload);
      expect(result[0]?.toDetail().isProgressing).toBe(true);
    });
  });

  describe("getWorkoutSummaries", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getWorkoutSummaries(90);
      expect(result).toEqual([]);
    });

    it("returns WorkoutSummary instances", async () => {
      const { repo } = makeRepository([
        {
          date: "2024-01-15",
          name: "Upper Body",
          exercise_count: 5,
          total_sets: 20,
          total_volume_kg: 3500,
          duration_minutes: 65,
        },
      ]);
      const result = await repo.getWorkoutSummaries(90);
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(WorkoutSummary);
      expect(result[0]?.toDetail().name).toBe("Upper Body");
      expect(result[0]?.toDetail().durationMinutes).toBe(65);
    });
  });
});
