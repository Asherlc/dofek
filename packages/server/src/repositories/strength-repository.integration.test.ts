import { formatDateYmd } from "@dofek/format/format";
import { STRENGTH_ACTIVITY_TYPES } from "@dofek/training/training";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { ActivityRepository } from "./activity-repository.ts";
import { StrengthRepository } from "./strength-repository.ts";

const idRowSchema = z.object({ id: z.string().uuid() });

describe("StrengthRepository activity scope", () => {
  let testContext: TestContext;
  const gapExerciseName = "Progressive Overload Gap Test";

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    await testContext.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('strength_scope_test', 'Strength Scope Test', ${TEST_USER_ID})`,
    );
    const exerciseRows = await executeWithSchema(
      testContext.db,
      idRowSchema,
      sql`INSERT INTO fitness.exercise (name, muscle_groups, equipment)
          VALUES ('Scope Test Press', ARRAY['chest']::text[], 'barbell')
          RETURNING id`,
    );
    const exerciseId = exerciseRows[0]?.id;
    if (!exerciseId) throw new Error("Strength scope test exercise was not created");

    for (const [activityIndex, activityType] of STRENGTH_ACTIVITY_TYPES.entries()) {
      const activityRows = await executeWithSchema(
        testContext.db,
        idRowSchema,
        sql`INSERT INTO fitness.activity (
              provider_id, user_id, external_id, activity_type, started_at, ended_at, name
            ) VALUES (
              'strength_scope_test',
              ${TEST_USER_ID},
              ${`strength-scope-${activityType}`},
              ${activityType},
              CURRENT_TIMESTAMP - ${activityIndex + 1}::int * INTERVAL '1 day',
              CURRENT_TIMESTAMP - ${activityIndex + 1}::int * INTERVAL '1 day' + INTERVAL '1 hour',
              ${`Scope Test ${activityType}`}
            )
            RETURNING id`,
      );
      const activityId = activityRows[0]?.id;
      if (!activityId)
        throw new Error(`Strength scope test activity ${activityType} was not created`);
      await testContext.db.execute(
        sql`INSERT INTO fitness.strength_set (
              activity_id, exercise_id, exercise_index, set_index, set_type, weight_kg, reps
            ) VALUES (${activityId}, ${exerciseId}, 0, 0, 'working', 50, 10)`,
      );
    }

    const gapExerciseRows = await executeWithSchema(
      testContext.db,
      idRowSchema,
      sql`INSERT INTO fitness.exercise (name, muscle_groups, equipment)
          VALUES (${gapExerciseName}, ARRAY['quadriceps']::text[], 'barbell')
          RETURNING id`,
    );
    const gapExerciseId = gapExerciseRows[0]?.id;
    if (!gapExerciseId) throw new Error("Progressive overload gap exercise was not created");

    for (const [weekOffset, weightKg] of [
      [6, 10],
      [4, 20],
      [2, 30],
    ] as const) {
      const activityRows = await executeWithSchema(
        testContext.db,
        idRowSchema,
        sql`INSERT INTO fitness.activity (
              provider_id, user_id, external_id, activity_type, started_at, ended_at, name
            ) VALUES (
              'strength_scope_test',
              ${TEST_USER_ID},
              ${`progressive-overload-gap-${weekOffset}`},
              'strength_training',
              date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
                - ${weekOffset}::int * INTERVAL '1 week' + INTERVAL '1 day',
              date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
                - ${weekOffset}::int * INTERVAL '1 week' + INTERVAL '1 day 1 hour',
              ${gapExerciseName}
            )
            RETURNING id`,
      );
      const activityId = activityRows[0]?.id;
      if (!activityId)
        throw new Error(`Progressive overload activity ${weekOffset} was not created`);
      await testContext.db.execute(
        sql`INSERT INTO fitness.strength_set (
              activity_id, exercise_id, exercise_index, set_index, set_type, weight_kg, reps
            ) VALUES (${activityId}, ${gapExerciseId}, 0, 0, 'working', ${weightKg}, 10)`,
      );
    }
  }, 60_000);

  afterAll(async () => {
    await testContext?.cleanup();
  });

  it("matches selected-window analytics to the activity-list strength scope", async () => {
    const strengthRepository = new StrengthRepository(testContext.db, TEST_USER_ID, "UTC");
    const activityRepository = new ActivityRepository(testContext.db, TEST_USER_ID, "UTC");

    const volume = await strengthRepository.getVolumeOverTime(30);
    const activities = await activityRepository.list({
      days: 30,
      endDate: formatDateYmd(new Date()),
      limit: 20,
      offset: 0,
      activityTypes: [...STRENGTH_ACTIVITY_TYPES],
    });

    expect(activities.items.map((activity) => activity.activity_type)).toEqual(
      expect.arrayContaining(["functional_strength", "functional_fitness"]),
    );
    expect(volume.reduce((total, week) => total + week.toDetail().workoutCount, 0)).toBe(
      activities.totalCount,
    );
  });

  it("preserves observed week labels and fits slope across calendar gaps", async () => {
    const repository = new StrengthRepository(testContext.db, TEST_USER_ID, "UTC");

    const trends = await repository.getProgressiveOverload(90);
    const detail = trends
      .find((trend) => trend.toDetail().exerciseName === gapExerciseName)
      ?.toDetail();

    expect(detail).toBeDefined();
    expect(detail?.observations.map((observation) => observation.totalVolumeKg)).toEqual([
      100, 200, 300,
    ]);
    expect(detail?.observations).toHaveLength(3);
    expect(detail?.slopeKgPerWeek).toBe(50);
    expect(detail?.period.observationCount).toBe(3);
    expect(detail?.period.elapsedWeekCount).toBe(5);
    expect(detail?.period.startWeek).toBe(detail?.observations[0]?.week);
    expect(detail?.period.endWeek).toBe(detail?.observations[2]?.week);
  });
});
