import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  exercise,
  exerciseAlias,
  strengthSet,
  strengthWorkout,
  TEST_USER_ID,
} from "../db/schema.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { importStrongCsv, STRONG_PROVIDER_ID } from "./strong-csv.ts";

// ============================================================
// Test CSV data
// ============================================================

const STRONG_CSV_HEADER =
  "Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,RPE";

const SIMPLE_CSV = `${STRONG_CSV_HEADER}
2026-03-01 10:00:00,Push Day,1h 15m,Bench Press (Barbell),1,100,8,,,,First workout,7
2026-03-01 10:00:00,Push Day,1h 15m,Bench Press (Barbell),2,100,8,,,,,7.5
2026-03-01 10:00:00,Push Day,1h 15m,Bench Press (Barbell),3,100,6,,,,,8
2026-03-01 10:00:00,Push Day,1h 15m,Overhead Press (Dumbbell),1,30,10,,,,,6
2026-03-01 10:00:00,Push Day,1h 15m,Overhead Press (Dumbbell),2,30,10,,,,,6.5`;

const TWO_WORKOUT_CSV = `${STRONG_CSV_HEADER}
2026-03-01 10:00:00,Push Day,1h 15m,Bench Press (Barbell),1,100,8,,,,,,7
2026-03-03 09:00:00,Pull Day,1h 0m,Deadlift (Barbell),1,140,5,,,,,,8
2026-03-03 09:00:00,Pull Day,1h 0m,Deadlift (Barbell),2,140,5,,,,,,8.5
2026-03-03 09:00:00,Pull Day,1h 0m,Barbell Row (Barbell),1,80,8,,,,,,6`;

const LBS_CSV = `${STRONG_CSV_HEADER}
2026-03-05 14:00:00,Leg Day,0:45:00,Squat (Barbell),1,225,5,,,,,,8`;

const WITH_NOTES_CSV = `${STRONG_CSV_HEADER}
2026-03-06 10:00:00,Full Body,1h 0m,Bench Press (Barbell),1,100,8,,,Felt strong,Great session,7`;

// ============================================================
// Tests
// ============================================================

describe("importStrongCsv() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
  }, 60_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  it("imports a single workout with multiple exercises and sets", async () => {
    const result = await importStrongCsv(ctx.db, SIMPLE_CSV, TEST_USER_ID, "kg");

    expect(result.provider).toBe(STRONG_PROVIDER_ID);
    expect(result.recordsSynced).toBe(1); // 1 workout
    expect(result.errors).toHaveLength(0);

    // Verify strength_workout
    const workouts = await ctx.db
      .select()
      .from(strengthWorkout)
      .where(eq(strengthWorkout.providerId, STRONG_PROVIDER_ID));

    expect(workouts.length).toBeGreaterThanOrEqual(1);
    const workout = workouts.find((w) => w.name === "Push Day");
    if (!workout) throw new Error("expected Push Day workout");
    // Strong CSV dates are parsed as local time (no timezone info in CSV)
    expect(workout.startedAt).toEqual(new Date("2026-03-01 10:00:00"));
    expect(workout.notes).toBe("First workout");

    // Verify strength_set rows
    const sets = await ctx.db
      .select()
      .from(strengthSet)
      .where(eq(strengthSet.workoutId, workout.id));

    expect(sets).toHaveLength(5); // 3 bench + 2 OHP

    // Verify bench press sets
    const benchSets = sets.filter((s) => s.setIndex <= 2 && s.exerciseIndex === 0);
    expect(benchSets).toHaveLength(3);
    const firstBenchSet = benchSets.find((s) => s.setIndex === 0);
    if (!firstBenchSet) throw new Error("expected first bench set");
    expect(firstBenchSet.weightKg).toBe(100);
    expect(firstBenchSet.reps).toBe(8);
    expect(firstBenchSet.rpe).toBe(7);

    // Verify exercise records created
    const exercises = await ctx.db.select().from(exercise);
    const benchExercise = exercises.find((e) => e.name === "Bench Press");
    if (!benchExercise) throw new Error("expected Bench Press exercise");
    expect(benchExercise.equipment).toBe("Barbell");

    const ohpExercise = exercises.find((e) => e.name === "Overhead Press");
    if (!ohpExercise) throw new Error("expected Overhead Press exercise");
    expect(ohpExercise.equipment).toBe("Dumbbell");
  });

  it("imports multiple workouts from CSV", async () => {
    const result = await importStrongCsv(ctx.db, TWO_WORKOUT_CSV, TEST_USER_ID, "kg");

    expect(result.recordsSynced).toBe(2); // 2 workouts
    expect(result.errors).toHaveLength(0);

    const workouts = await ctx.db
      .select()
      .from(strengthWorkout)
      .where(eq(strengthWorkout.providerId, STRONG_PROVIDER_ID));

    const pushDay = workouts.find((w) => w.name === "Push Day");
    const pullDay = workouts.find((w) => w.name === "Pull Day");
    expect(pushDay).toBeDefined();
    expect(pullDay).toBeDefined();
  });

  it("converts lbs to kg when weightUnit is lbs", async () => {
    const result = await importStrongCsv(ctx.db, LBS_CSV, TEST_USER_ID, "lbs");

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);

    const workouts = await ctx.db
      .select()
      .from(strengthWorkout)
      .where(eq(strengthWorkout.name, "Leg Day"));

    expect(workouts).toHaveLength(1);
    const workout = workouts[0];
    if (!workout) throw new Error("expected Leg Day workout");

    const sets = await ctx.db
      .select()
      .from(strengthSet)
      .where(eq(strengthSet.workoutId, workout.id));

    expect(sets).toHaveLength(1);
    // 225 lbs * 0.453592 = ~102.058 kg
    expect(sets[0]?.weightKg).toBeCloseTo(102.058, 1);
  });

  it("upserts workouts on re-import (no duplicates)", async () => {
    await importStrongCsv(ctx.db, SIMPLE_CSV, TEST_USER_ID, "kg");
    await importStrongCsv(ctx.db, SIMPLE_CSV, TEST_USER_ID, "kg");

    const workouts = await ctx.db
      .select()
      .from(strengthWorkout)
      .where(eq(strengthWorkout.name, "Push Day"));

    expect(workouts).toHaveLength(1);
  });

  it("stores workout and set notes", async () => {
    const result = await importStrongCsv(ctx.db, WITH_NOTES_CSV, TEST_USER_ID, "kg");

    expect(result.recordsSynced).toBe(1);

    const workouts = await ctx.db
      .select()
      .from(strengthWorkout)
      .where(eq(strengthWorkout.name, "Full Body"));

    expect(workouts).toHaveLength(1);
    expect(workouts[0]?.notes).toBe("Great session");

    const sets = await ctx.db
      .select()
      .from(strengthSet)
      .where(eq(strengthSet.workoutId, workouts[0]?.id ?? ""));

    expect(sets).toHaveLength(1);
    expect(sets[0]?.notes).toBe("Felt strong");
  });

  it("creates exercise aliases for provider mapping", async () => {
    await importStrongCsv(ctx.db, SIMPLE_CSV, TEST_USER_ID, "kg");

    const aliases = await ctx.db
      .select()
      .from(exerciseAlias)
      .where(eq(exerciseAlias.providerId, STRONG_PROVIDER_ID));

    expect(aliases.length).toBeGreaterThanOrEqual(2);
    const benchAlias = aliases.find((a) => a.providerExerciseName === "Bench Press (Barbell)");
    expect(benchAlias).toBeDefined();
  });

  it("returns empty result for empty CSV", async () => {
    const result = await importStrongCsv(ctx.db, STRONG_CSV_HEADER, TEST_USER_ID, "kg");

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("handles duration in HH:MM:SS format", async () => {
    const result = await importStrongCsv(ctx.db, LBS_CSV, TEST_USER_ID, "lbs");
    expect(result.recordsSynced).toBe(1);

    const workouts = await ctx.db
      .select()
      .from(strengthWorkout)
      .where(eq(strengthWorkout.name, "Leg Day"));

    expect(workouts).toHaveLength(1);
    // Duration is 0:45:00 = 2700 seconds
    const workout = workouts[0];
    if (!workout) throw new Error("expected workout");
    if (workout.endedAt && workout.startedAt) {
      const durationMs = workout.endedAt.getTime() - workout.startedAt.getTime();
      expect(durationMs).toBe(2700 * 1000);
    }
  });
});
