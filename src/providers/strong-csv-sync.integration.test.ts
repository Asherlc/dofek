import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWithProviderIngestContext } from "../db/provider-ingest-context.ts";
import { activity, strengthSet } from "../db/schema/activity.ts";
import { TEST_USER_ID } from "../db/schema/core.ts";
import {
  exercise,
  exerciseAlias,
  exerciseAliasSource,
  exerciseSource,
} from "../db/schema/reference.ts";
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
    const result = await runWithProviderIngestContext({ homeTimezone: "America/Los_Angeles" }, () =>
      importStrongCsv(ctx.db, SIMPLE_CSV, TEST_USER_ID, "kg", "America/Los_Angeles"),
    );

    expect(result.provider).toBe(STRONG_PROVIDER_ID);
    expect(result.recordsSynced).toBe(1); // 1 workout
    expect(result.errors).toHaveLength(0);

    // Verify activity
    const activities = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, STRONG_PROVIDER_ID));

    expect(activities.length).toBeGreaterThanOrEqual(1);
    const workout = activities.find((w) => w.name === "Push Day");
    if (!workout) throw new Error("expected Push Day workout");
    // Strong CSV dates are parsed as local time (no timezone info in CSV)
    expect(workout.startedAt).toEqual(new Date("2026-03-01T18:00:00.000Z"));
    expect(workout.timezone).toBe("America/Los_Angeles");
    expect(workout.startUtcOffsetMinutes).toBe(-480);
    expect(workout.localTimeSource).toBe("device_timezone");
    expect(workout.notes).toBe("First workout");

    // Verify strength_set rows
    const sets = await ctx.db
      .select()
      .from(strengthSet)
      .where(eq(strengthSet.activityId, workout.id))
      .orderBy(asc(strengthSet.setIndex));

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
    const result = await importStrongCsv(
      ctx.db,
      TWO_WORKOUT_CSV,
      TEST_USER_ID,
      "kg",
      "America/Los_Angeles",
    );

    expect(result.recordsSynced).toBe(2); // 2 workouts
    expect(result.errors).toHaveLength(0);

    const activities = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, STRONG_PROVIDER_ID));

    const pushDay = activities.find((w) => w.name === "Push Day");
    const pullDay = activities.find((w) => w.name === "Pull Day");
    expect(pushDay).toBeDefined();
    expect(pullDay).toBeDefined();
  });

  it("converts lbs to kg when weightUnit is lbs", async () => {
    const result = await importStrongCsv(
      ctx.db,
      LBS_CSV,
      TEST_USER_ID,
      "lbs",
      "America/Los_Angeles",
    );

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);

    const activities = await ctx.db.select().from(activity).where(eq(activity.name, "Leg Day"));

    expect(activities).toHaveLength(1);
    const workout = activities[0];
    if (!workout) throw new Error("expected Leg Day workout");

    const sets = await ctx.db
      .select()
      .from(strengthSet)
      .where(eq(strengthSet.activityId, workout.id));

    expect(sets).toHaveLength(1);
    // 225 lbs * 0.453592 = ~102.058 kg
    expect(sets[0]?.weightKg).toBeCloseTo(102.058, 1);
  });

  it("stores zero-load timed rows as rests and keeps sequential CSV order", async () => {
    const csv = [
      STRONG_CSV_HEADER,
      '2026-09-01 07:55:54,"Rest test","30m","Squat (Barbell)",0,0,0,,300,,',
      '2026-09-01 07:55:54,"Rest test","30m","Squat (Barbell)",0,0,0,,300,,',
      '2026-09-01 07:55:54,"Rest test","30m","Squat (Barbell)",1,155,6,,,,',
    ].join("\n");

    const result = await importStrongCsv(ctx.db, csv, TEST_USER_ID, "lbs", "America/Los_Angeles");
    expect(result.errors).toHaveLength(0);

    const workout = (await ctx.db.select().from(activity).where(eq(activity.name, "Rest test")))[0];
    if (!workout) throw new Error("expected Rest test workout");
    const sets = await ctx.db
      .select()
      .from(strengthSet)
      .where(eq(strengthSet.activityId, workout.id));

    expect(sets.map((set) => set.setIndex)).toEqual([0, 1, 2]);
    expect(sets.map((set) => set.setType)).toEqual(["rest", "rest", "working"]);
    expect(sets[2]?.weightKg).toBe(70.307);
  });

  it("upserts workouts on re-import (no duplicates)", async () => {
    await importStrongCsv(ctx.db, SIMPLE_CSV, TEST_USER_ID, "kg", "America/Los_Angeles");
    await importStrongCsv(ctx.db, SIMPLE_CSV, TEST_USER_ID, "kg", "America/Los_Angeles");

    const activities = await ctx.db.select().from(activity).where(eq(activity.name, "Push Day"));

    expect(activities).toHaveLength(1);
  });

  it("keeps the prior workout sets when a replacement fails", async () => {
    const original = `${STRONG_CSV_HEADER}\n2026-08-26 16:00:50,Atomic replacement,45m,Deadlift (Barbell),1,205,4,,,,,`;
    const replacement = `${STRONG_CSV_HEADER}\n2026-08-26 16:00:50,Atomic replacement,45m,Deadlift (Barbell),1,225,4,,,,,`;
    await importStrongCsv(ctx.db, original, TEST_USER_ID, "lbs", "America/Los_Angeles");
    const workout = (
      await ctx.db.select().from(activity).where(eq(activity.name, "Atomic replacement"))
    )[0];
    if (!workout) throw new Error("expected Atomic replacement workout");

    await ctx.db.execute(sql`CREATE FUNCTION fitness.reject_test_strength_set_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'test replacement rejection';
      END;
      $$`);
    await ctx.db.execute(sql`CREATE TRIGGER reject_test_strength_set_insert
      BEFORE INSERT ON fitness.strength_set
      FOR EACH ROW EXECUTE FUNCTION fitness.reject_test_strength_set_insert()`);
    try {
      const result = await importStrongCsv(
        ctx.db,
        replacement,
        TEST_USER_ID,
        "lbs",
        "America/Los_Angeles",
      );
      expect(result.errors).toHaveLength(1);
    } finally {
      await ctx.db.execute(
        sql`DROP TRIGGER reject_test_strength_set_insert ON fitness.strength_set`,
      );
      await ctx.db.execute(sql`DROP FUNCTION fitness.reject_test_strength_set_insert()`);
    }

    const sets = await ctx.db
      .select()
      .from(strengthSet)
      .where(eq(strengthSet.activityId, workout.id));
    expect(sets).toHaveLength(1);
    expect(sets[0]?.weightKg).toBe(92.986);
  });

  it("stores workout and set notes", async () => {
    const result = await importStrongCsv(
      ctx.db,
      WITH_NOTES_CSV,
      TEST_USER_ID,
      "kg",
      "America/Los_Angeles",
    );

    expect(result.recordsSynced).toBe(1);

    const activities = await ctx.db.select().from(activity).where(eq(activity.name, "Full Body"));

    expect(activities).toHaveLength(1);
    expect(activities[0]?.notes).toBe("Great session");

    const sets = await ctx.db
      .select()
      .from(strengthSet)
      .where(eq(strengthSet.activityId, activities[0]?.id ?? ""));

    expect(sets).toHaveLength(1);
    expect(sets[0]?.notes).toBe("Felt strong");
  });

  it("creates exercise aliases for provider mapping", async () => {
    await importStrongCsv(ctx.db, SIMPLE_CSV, TEST_USER_ID, "kg", "America/Los_Angeles");

    const aliases = await ctx.db
      .select()
      .from(exerciseAlias)
      .where(eq(exerciseAlias.providerId, STRONG_PROVIDER_ID));

    expect(aliases.length).toBeGreaterThanOrEqual(2);
    const benchAlias = aliases.find((a) => a.providerExerciseName === "Bench Press (Barbell)");
    expect(benchAlias).toBeDefined();

    const sources = await ctx.db
      .select()
      .from(exerciseSource)
      .where(
        and(
          eq(exerciseSource.userId, TEST_USER_ID),
          eq(exerciseSource.providerId, STRONG_PROVIDER_ID),
        ),
      );
    expect(sources.length).toBeGreaterThanOrEqual(2);

    const aliasSources = await ctx.db.select().from(exerciseAliasSource);
    expect(aliasSources).toEqual(
      expect.arrayContaining(
        aliases.map((alias) =>
          expect.objectContaining({
            aliasId: alias.id,
            exerciseId: alias.exerciseId,
          }),
        ),
      ),
    );
  });

  it("reuses an established provider alias when inferred equipment changes", async () => {
    const [canonicalExercise] = await ctx.db
      .insert(exercise)
      .values({ name: "Pull Up", equipment: "BODY" })
      .onConflictDoNothing()
      .returning();
    const existingExercise =
      canonicalExercise ??
      (
        await ctx.db
          .select()
          .from(exercise)
          .where(and(eq(exercise.name, "Pull Up"), eq(exercise.equipment, "BODY")))
      )[0];
    if (!existingExercise) throw new Error("expected canonical Pull Up exercise");

    await ctx.db
      .insert(exerciseAlias)
      .values({
        exerciseId: existingExercise.id,
        providerId: STRONG_PROVIDER_ID,
        providerExerciseId: null,
        providerExerciseName: "Pull Up",
      })
      .onConflictDoNothing();

    const csv = `${STRONG_CSV_HEADER}\n2026-08-26 16:00:50,Deadlift,45m,Pull Up,1,0,8,,,,,`;
    const result = await importStrongCsv(ctx.db, csv, TEST_USER_ID, "lbs", "America/Los_Angeles");

    expect(result.errors).toHaveLength(0);
    const workout = (await ctx.db.select().from(activity).where(eq(activity.name, "Deadlift")))[0];
    if (!workout) throw new Error("expected Deadlift workout");
    const sets = await ctx.db
      .select()
      .from(strengthSet)
      .where(eq(strengthSet.activityId, workout.id));
    expect(sets).toHaveLength(1);
    expect(sets[0]?.exerciseId).toBe(existingExercise.id);
  });

  it("returns empty result for empty CSV", async () => {
    const result = await importStrongCsv(
      ctx.db,
      STRONG_CSV_HEADER,
      TEST_USER_ID,
      "kg",
      "America/Los_Angeles",
    );

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("handles duration in HH:MM:SS format", async () => {
    const result = await importStrongCsv(
      ctx.db,
      LBS_CSV,
      TEST_USER_ID,
      "lbs",
      "America/Los_Angeles",
    );
    expect(result.recordsSynced).toBe(1);

    const activities = await ctx.db.select().from(activity).where(eq(activity.name, "Leg Day"));

    expect(activities).toHaveLength(1);
    // Duration is 0:45:00 = 2700 seconds
    const workout = activities[0];
    if (!workout) throw new Error("expected workout");
    if (workout.endedAt && workout.startedAt) {
      const durationMs = workout.endedAt.getTime() - workout.startedAt.getTime();
      expect(durationMs).toBe(2700 * 1000);
    }
  });

  it("inserts a record into the activity table for each workout", async () => {
    await importStrongCsv(ctx.db, SIMPLE_CSV, TEST_USER_ID, "kg", "America/Los_Angeles");

    const activities = await ctx.db
      .select()
      .from(activity)
      .where(and(eq(activity.providerId, STRONG_PROVIDER_ID), eq(activity.name, "Push Day")));

    expect(activities).toHaveLength(1);
    expect(activities[0]?.canonicalType).toBe("strength");
    expect(activities[0]?.name).toBe("Push Day");
    expect(activities[0]?.startedAt).toEqual(new Date("2026-03-01T18:00:00.000Z"));
  });
});
