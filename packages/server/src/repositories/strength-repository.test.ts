import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { ProgressiveOverload } from "./progressive-overload.ts";
import {
  EstimatedOneRepMax,
  ExerciseWithSets,
  MuscleGroupVolume,
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
  it("describes an increasing first-to-latest estimated max", () => {
    const entry = new EstimatedOneRepMax({ exerciseName: "Bench Press", equipment: "BARBELL" }, [
      { date: "2024-01-01", estimatedMax: 100, actualWeight: 80, actualReps: 8 },
      { date: "2024-01-15", estimatedMax: 105.2, actualWeight: 85, actualReps: 7 },
    ]);
    const detail = entry.toDetail();
    expect(detail).toEqual({
      exerciseName: "Bench Press",
      equipment: "BARBELL",
      history: [
        { date: "2024-01-01", estimatedMax: 100, actualWeight: 80, actualReps: 8 },
        { date: "2024-01-15", estimatedMax: 105.2, actualWeight: 85, actualReps: 7 },
      ],
      trend: {
        direction: "increasing",
        summary: "Estimated max increased from first to latest estimate.",
        changeMagnitudeKg: 5.2,
        firstDate: "2024-01-01",
        latestDate: "2024-01-15",
      },
    });
  });

  it("describes a decreasing first-to-latest estimated max", () => {
    const entry = new EstimatedOneRepMax({ exerciseName: "Squat", equipment: null }, [
      { date: "2024-01-01", estimatedMax: 150, actualWeight: 120, actualReps: 5 },
      { date: "2024-02-01", estimatedMax: 142.4, actualWeight: 115, actualReps: 5 },
    ]);

    expect(entry.toDetail().trend).toEqual({
      direction: "decreasing",
      summary: "Estimated max decreased from first to latest estimate.",
      changeMagnitudeKg: 7.6,
      firstDate: "2024-01-01",
      latestDate: "2024-02-01",
    });
  });

  it("describes an unchanged first-to-latest estimated max", () => {
    const entry = new EstimatedOneRepMax({ exerciseName: "Row", equipment: null }, [
      { date: "2024-01-01", estimatedMax: 80, actualWeight: 70, actualReps: 4 },
      { date: "2024-02-01", estimatedMax: 80, actualWeight: 70, actualReps: 4 },
    ]);

    expect(entry.toDetail().trend).toEqual({
      direction: "stable",
      summary: "Estimated max did not change from first to latest estimate.",
      changeMagnitudeKg: 0,
      firstDate: "2024-01-01",
      latestDate: "2024-02-01",
    });
  });

  it("rejects an empty history because trend evidence needs date bounds", () => {
    expect(() =>
      new EstimatedOneRepMax({ exerciseName: "Row", equipment: null }, []).toDetail(),
    ).toThrow("Estimated max history must contain at least one observation.");
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

describe("ExerciseWithSets", () => {
  it("serializes to API shape with sets", () => {
    const exercise = new ExerciseWithSets(
      0,
      "Bench Press",
      "BARBELL",
      ["CHEST", "TRICEPS"],
      "STRENGTH",
      [
        {
          setIndex: 0,
          setType: "working",
          weightKg: 80,
          reps: 8,
          durationSeconds: null,
          rpe: null,
          notes: null,
        },
        {
          setIndex: 1,
          setType: "working",
          weightKg: 85,
          reps: 6,
          durationSeconds: null,
          rpe: 9,
          notes: null,
        },
      ],
    );
    const detail = exercise.toDetail();
    expect(detail.exerciseName).toBe("Bench Press");
    expect(detail.equipment).toBe("BARBELL");
    expect(detail.muscleGroups).toEqual(["CHEST", "TRICEPS"]);
    expect(detail.exerciseType).toBe("STRENGTH");
    expect(detail.sets).toHaveLength(2);
    expect(detail.sets[0]).toEqual({
      setIndex: 0,
      setType: "working",
      weightKg: 80,
      reps: 8,
      durationSeconds: null,
      rpe: null,
      notes: null,
    });
  });

  it("handles timed exercises with duration instead of weight/reps", () => {
    const exercise = new ExerciseWithSets(0, "Front Plank", "BODY", ["CORE"], "STRENGTH", [
      {
        setIndex: 0,
        setType: "working",
        weightKg: null,
        reps: null,
        durationSeconds: 60,
        rpe: null,
        notes: null,
      },
    ]);
    const detail = exercise.toDetail();
    expect(detail.sets[0]?.weightKg).toBeNull();
    expect(detail.sets[0]?.reps).toBeNull();
    expect(detail.sets[0]?.durationSeconds).toBe(60);
  });

  it("handles null equipment and muscle groups", () => {
    const exercise = new ExerciseWithSets(0, "Custom Exercise", null, null, null, []);
    const detail = exercise.toDetail();
    expect(detail.equipment).toBeNull();
    expect(detail.muscleGroups).toBeNull();
    expect(detail.exerciseType).toBeNull();
    expect(detail.sets).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

describe("StrengthRepository", () => {
  const dialect = new PgDialect();

  function makeRepository(rows: Record<string, unknown>[] = []) {
    const execute = vi.fn().mockResolvedValue(
      rows.map((row) => ({
        member_activity_id: "member-1",
        member_provider_id: "provider-1",
        source_priority: 100,
        ...row,
      })),
    );
    const db = { execute };
    const repo = new StrengthRepository(db, "user-1", "UTC");
    return { repo, execute };
  }

  async function expectFiniteDaysFilter(
    runQuery: (repo: StrengthRepository) => Promise<unknown>,
  ): Promise<void> {
    const { repo, execute } = makeRepository([]);

    await runQuery(repo);

    const compiledQuery = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
    expect(compiledQuery.sql).toContain("a.started_at > CURRENT_TIMESTAMP -");
    expect(compiledQuery.sql).toContain("::int * INTERVAL '1 day'");
    expect(compiledQuery.params).toEqual(expect.arrayContaining(["user-1", 30]));
  }

  async function expectUnboundedDaysFilter(
    runQuery: (repo: StrengthRepository) => Promise<unknown>,
  ): Promise<void> {
    const { repo, execute } = makeRepository([]);

    await runQuery(repo);

    const compiledQuery = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
    expect(compiledQuery.sql).toContain("a.user_id =");
    expect(compiledQuery.sql).not.toContain("CURRENT_TIMESTAMP -");
    expect(compiledQuery.params).not.toContain(null);
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

    it("applies finite selected-range lower-bound filters", async () => {
      await expectFiniteDaysFilter((repo) => repo.getVolumeOverTime(30));
    });

    it("omits selected-range lower-bound filters when days is null", async () => {
      await expectUnboundedDaysFilter((repo) => repo.getVolumeOverTime(null));
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
          equipment: null,
          workout_date: "2024-01-01",
          estimated_max: 100,
          actual_weight: 80,
          actual_reps: 8,
        },
        {
          exercise_name: "Bench Press",
          equipment: null,
          workout_date: "2024-01-15",
          estimated_max: 105,
          actual_weight: 85,
          actual_reps: 7,
        },
        {
          exercise_name: "Squat",
          equipment: null,
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

    it("keeps same-name estimated max histories distinct by equipment", async () => {
      const { repo } = makeRepository([
        {
          exercise_name: "Chest Press",
          equipment: "BARBELL",
          workout_date: "2024-01-01",
          estimated_max: 100,
          actual_weight: 80,
          actual_reps: 8,
        },
        {
          exercise_name: "Chest Press",
          equipment: "BARBELL",
          workout_date: "2024-01-08",
          estimated_max: 105,
          actual_weight: 85,
          actual_reps: 7,
        },
        {
          exercise_name: "Chest Press",
          equipment: "DUMBBELL",
          workout_date: "2024-01-01",
          estimated_max: 60,
          actual_weight: 48,
          actual_reps: 8,
        },
        {
          exercise_name: "Chest Press",
          equipment: "DUMBBELL",
          workout_date: "2024-01-08",
          estimated_max: 64,
          actual_weight: 52,
          actual_reps: 7,
        },
      ]);

      const result = (await repo.getEstimatedOneRepMax(90)).map((exercise) => exercise.toDetail());

      expect(result).toEqual([
        expect.objectContaining({
          equipment: "BARBELL",
          exerciseName: "Chest Press",
          history: expect.arrayContaining([expect.objectContaining({ estimatedMax: 100 })]),
        }),
        expect.objectContaining({
          equipment: "DUMBBELL",
          exerciseName: "Chest Press",
          history: expect.arrayContaining([expect.objectContaining({ estimatedMax: 60 })]),
        }),
      ]);
      expect(result.map((exercise) => exercise.history)).toEqual([
        [
          expect.objectContaining({ estimatedMax: 100 }),
          expect.objectContaining({ estimatedMax: 105 }),
        ],
        [
          expect.objectContaining({ estimatedMax: 60 }),
          expect.objectContaining({ estimatedMax: 64 }),
        ],
      ]);
    });

    it("applies finite selected-range lower-bound filters", async () => {
      await expectFiniteDaysFilter((repo) => repo.getEstimatedOneRepMax(30));
    });

    it("omits selected-range lower-bound filters when days is null", async () => {
      await expectUnboundedDaysFilter((repo) => repo.getEstimatedOneRepMax(null));
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

    it("applies finite selected-range lower-bound filters", async () => {
      await expectFiniteDaysFilter((repo) => repo.getMuscleGroupVolume(30));
    });

    it("omits selected-range lower-bound filters when days is null", async () => {
      await expectUnboundedDaysFilter((repo) => repo.getMuscleGroupVolume(null));
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
        { exercise_name: "Curls", equipment: null, week: "2024-01-08", weekly_volume: 500 },
      ]);
      const result = await repo.getProgressiveOverload(90);
      expect(result).toEqual([]);
    });

    it("returns ProgressiveOverload instances for qualifying exercises", async () => {
      const { repo } = makeRepository([
        {
          exercise_name: "Deadlift",
          equipment: null,
          week: "2024-01-08",
          weekly_volume: 1000,
        },
        {
          exercise_name: "Deadlift",
          equipment: null,
          week: "2024-01-15",
          weekly_volume: 1100,
        },
        {
          exercise_name: "Deadlift",
          equipment: null,
          week: "2024-01-22",
          weekly_volume: 1200,
        },
      ]);
      const result = await repo.getProgressiveOverload(90);
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(ProgressiveOverload);
      expect(result[0]?.toDetail().trend).toBe("increasing");
    });

    it("keeps same-name progressive overload observations distinct by equipment", async () => {
      const { repo } = makeRepository([
        {
          exercise_name: "Chest Press",
          equipment: "BARBELL",
          week: "2024-01-01",
          weekly_volume: 1000,
        },
        {
          exercise_name: "Chest Press",
          equipment: "BARBELL",
          week: "2024-01-08",
          weekly_volume: 1100,
        },
        {
          exercise_name: "Chest Press",
          equipment: "DUMBBELL",
          week: "2024-01-01",
          weekly_volume: 500,
        },
        {
          exercise_name: "Chest Press",
          equipment: "DUMBBELL",
          week: "2024-01-08",
          weekly_volume: 550,
        },
      ]);

      const result = (await repo.getProgressiveOverload(90)).map((exercise) => exercise.toDetail());

      expect(result).toEqual([
        expect.objectContaining({
          equipment: "BARBELL",
          exerciseName: "Chest Press",
          observations: [
            { totalVolumeKg: 1000, week: "2024-01-01" },
            { totalVolumeKg: 1100, week: "2024-01-08" },
          ],
        }),
        expect.objectContaining({
          equipment: "DUMBBELL",
          exerciseName: "Chest Press",
          observations: [
            { totalVolumeKg: 500, week: "2024-01-01" },
            { totalVolumeKg: 550, week: "2024-01-08" },
          ],
        }),
      ]);
    });

    it("applies finite selected-range lower-bound filters", async () => {
      await expectFiniteDaysFilter((repo) => repo.getProgressiveOverload(30));
    });

    it("omits selected-range lower-bound filters when days is null", async () => {
      await expectUnboundedDaysFilter((repo) => repo.getProgressiveOverload(null));
    });
  });

  describe("getExercisesForActivity", () => {
    it("returns empty array when no matching strength workout", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getExercisesForActivity("activity-1");
      expect(result).toEqual([]);
    });

    it("groups flat rows into exercises by normalized exercise identity", async () => {
      const { repo } = makeRepository([
        {
          exercise_name: "Bench Press",
          equipment: "BARBELL",
          muscle_groups: ["CHEST", "TRICEPS"],
          exercise_type: "STRENGTH",
          exercise_index: 0,
          set_index: 0,
          set_type: "working",
          weight_kg: 80,
          reps: 8,
          duration_seconds: null,
          rpe: null,
          notes: null,
        },
        {
          exercise_name: "Bench Press",
          equipment: "BARBELL",
          muscle_groups: ["CHEST", "TRICEPS"],
          exercise_type: "STRENGTH",
          exercise_index: 0,
          set_index: 1,
          set_type: "working",
          weight_kg: 85,
          reps: 6,
          duration_seconds: null,
          rpe: 9,
          notes: null,
        },
        {
          exercise_name: "Front Plank",
          equipment: "BODY",
          muscle_groups: ["CORE"],
          exercise_type: "STRENGTH",
          exercise_index: 1,
          set_index: 0,
          set_type: "working",
          weight_kg: null,
          reps: null,
          duration_seconds: 60,
          rpe: null,
          notes: null,
        },
      ]);
      const result = await repo.getExercisesForActivity("activity-1");
      expect(result).toHaveLength(2);
      expect(result[0]).toBeInstanceOf(ExerciseWithSets);
      expect(result[0]?.toDetail().exerciseName).toBe("Bench Press");
      expect(result[0]?.toDetail().sets).toHaveLength(2);
      expect(result[1]?.toDetail().exerciseName).toBe("Front Plank");
      expect(result[1]?.toDetail().sets).toHaveLength(1);
      expect(result[1]?.toDetail().sets[0]?.durationSeconds).toBe(60);
    });

    it("keeps distinct exercises when different members reuse a provider-local index", async () => {
      const { repo } = makeRepository([
        {
          member_activity_id: "strong-member",
          source_priority: 20,
          exercise_name: "Deadlift",
          equipment: "BARBELL",
          muscle_groups: ["BACK", "GLUTES", "HAMSTRINGS"],
          exercise_type: "STRENGTH",
          exercise_index: 0,
          set_index: 0,
          set_type: "working",
          weight_kg: 100,
          reps: 5,
          duration_seconds: null,
          rpe: null,
          notes: null,
        },
        {
          member_activity_id: "mirror-member",
          source_priority: 10,
          exercise_name: "Bench Press",
          equipment: "BARBELL",
          muscle_groups: ["CHEST", "TRICEPS"],
          exercise_type: "STRENGTH",
          exercise_index: 0,
          set_index: 0,
          set_type: "working",
          weight_kg: 80,
          reps: 8,
          duration_seconds: null,
          rpe: null,
          notes: null,
        },
      ]);

      const details = (await repo.getExercisesForActivity("stable-group")).map((exercise) =>
        exercise.toDetail(),
      );

      expect(details.map((exercise) => exercise.exerciseName)).toEqual(["Bench Press", "Deadlift"]);
      expect(details.map((exercise) => exercise.exerciseIndex)).toEqual([0, 1]);
    });

    it("deduplicates mirrored sets by exact signature while retaining disjoint and rest sets", async () => {
      const { repo } = makeRepository([
        {
          member_activity_id: "strong-member",
          source_priority: 5,
          exercise_name: "Deadlift",
          equipment: "BARBELL",
          muscle_groups: ["BACK"],
          exercise_type: "STRENGTH",
          exercise_index: 0,
          set_index: 0,
          set_type: "working",
          weight_kg: 0,
          reps: 0,
          duration_seconds: null,
          rpe: 7,
          notes: null,
        },
        {
          member_activity_id: "mirror-member",
          source_priority: 20,
          exercise_name: " deadlift ",
          equipment: "barbell",
          muscle_groups: ["BACK", "GLUTES", "HAMSTRINGS"],
          exercise_type: "STRENGTH",
          exercise_index: 0,
          set_index: 0,
          set_type: "working",
          weight_kg: 0,
          reps: 0,
          duration_seconds: null,
          rpe: 8,
          notes: "Complete mirror",
        },
        {
          member_activity_id: "strong-member",
          source_priority: 20,
          exercise_name: "Deadlift",
          equipment: "BARBELL",
          muscle_groups: ["BACK"],
          exercise_type: "STRENGTH",
          exercise_index: 0,
          set_index: 1,
          set_type: "working",
          weight_kg: 110,
          reps: 3,
          duration_seconds: null,
          rpe: 7,
          notes: null,
        },
        {
          member_activity_id: "mirror-member",
          source_priority: 5,
          exercise_name: "Deadlift",
          equipment: "BARBELL",
          muscle_groups: ["BACK"],
          exercise_type: "STRENGTH",
          exercise_index: 0,
          set_index: 1,
          set_type: "working",
          weight_kg: 110,
          reps: 3,
          duration_seconds: null,
          rpe: 9,
          notes: null,
        },
        {
          member_activity_id: "strong-member",
          source_priority: 5,
          exercise_name: "Deadlift",
          equipment: "BARBELL",
          muscle_groups: ["BACK"],
          exercise_type: "STRENGTH",
          exercise_index: 0,
          set_index: 2,
          set_type: "rest",
          weight_kg: null,
          reps: null,
          duration_seconds: 0,
          rpe: null,
          notes: null,
        },
      ]);

      const detail = (await repo.getExercisesForActivity("stable-group"))[0]?.toDetail();

      expect(detail?.sets).toEqual([
        {
          durationSeconds: null,
          notes: "Complete mirror",
          reps: 0,
          rpe: 8,
          setIndex: 0,
          setType: "working",
          weightKg: 0,
        },
        {
          durationSeconds: null,
          notes: null,
          reps: 3,
          rpe: 9,
          setIndex: 1,
          setType: "working",
          weightKg: 110,
        },
        {
          durationSeconds: 0,
          notes: null,
          reps: null,
          rpe: null,
          setIndex: 2,
          setType: "rest",
          weightKg: null,
        },
      ]);
    });

    it("uses exercise metadata when stored muscle groups are missing", async () => {
      const { repo } = makeRepository([
        {
          exercise_name: "Bulgarian Split Squat",
          equipment: null,
          muscle_groups: null,
          exercise_type: null,
          exercise_index: 0,
          set_index: 0,
          set_type: "working",
          weight_kg: 24,
          reps: 8,
          duration_seconds: null,
          rpe: null,
          notes: null,
        },
      ]);

      const result = await repo.getExercisesForActivity("activity-1");

      expect(result[0]?.toDetail().muscleGroups).toEqual(["QUADRICEPS", "GLUTES", "HAMSTRINGS"]);
      expect(result[0]?.toDetail().exerciseType).toBe("STRENGTH");
    });

    it("uses exercise metadata when stored muscle groups are only broad back", async () => {
      const { repo } = makeRepository([
        {
          exercise_name: "Pull Up",
          equipment: null,
          muscle_groups: ["BACK"],
          exercise_type: "STRENGTH",
          exercise_index: 0,
          set_index: 0,
          set_type: "working",
          weight_kg: null,
          reps: 8,
          duration_seconds: null,
          rpe: null,
          notes: null,
        },
      ]);

      const result = await repo.getExercisesForActivity("activity-1");

      expect(result[0]?.toDetail().muscleGroups).toEqual(["LATS", "UPPER_BACK", "BICEPS"]);
    });

    it("treats empty stored muscle groups as missing metadata", async () => {
      const { repo } = makeRepository([
        {
          exercise_name: "Bulgarian Split Squat",
          equipment: null,
          muscle_groups: [],
          exercise_type: null,
          exercise_index: 0,
          set_index: 0,
          set_type: "working",
          weight_kg: 24,
          reps: 8,
          duration_seconds: null,
          rpe: null,
          notes: null,
        },
      ]);

      const result = await repo.getExercisesForActivity("activity-1");

      expect(result[0]?.toDetail().muscleGroups).toEqual(["QUADRICEPS", "GLUTES", "HAMSTRINGS"]);
      expect(result[0]?.toDetail().exerciseType).toBe("STRENGTH");
    });

    it("does not infer strength type from empty stored muscle groups for unknown exercises", async () => {
      const { repo } = makeRepository([
        {
          exercise_name: "Custom Movement",
          equipment: null,
          muscle_groups: [],
          exercise_type: null,
          exercise_index: 0,
          set_index: 0,
          set_type: "working",
          weight_kg: 24,
          reps: 8,
          duration_seconds: null,
          rpe: null,
          notes: null,
        },
      ]);

      const result = await repo.getExercisesForActivity("activity-1");

      expect(result[0]?.toDetail().muscleGroups).toEqual([]);
      expect(result[0]?.toDetail().exerciseType).toBeNull();
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

    it("omits selected-range lower-bound filters when days is null", async () => {
      const { repo, execute } = makeRepository([]);

      await repo.getWorkoutSummaries(null);

      const compiledQuery = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
      expect(compiledQuery.sql).not.toContain("CURRENT_TIMESTAMP -");
      expect(compiledQuery.params).toEqual(["user-1", "UTC", "user-1"]);
    });
  });
});
