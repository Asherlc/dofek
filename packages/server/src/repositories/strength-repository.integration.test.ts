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
const activityIdentityRowSchema = z.object({
  group_id: z.string().uuid(),
  id: z.string().uuid(),
});
const primaryMemberRowSchema = z.object({ primary_activity_id: z.string().uuid() });

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
              provider_id, user_id, external_id, canonical_type, provider_type, modality, started_at, ended_at, name
            ) VALUES (
              'strength_scope_test',
              ${TEST_USER_ID},
              ${`strength-scope-${activityType}`},
              ${activityType}, ${activityType}, NULL,
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
              provider_id, user_id, external_id, canonical_type, provider_type, modality, started_at, ended_at, name
            ) VALUES (
              'strength_scope_test',
              ${TEST_USER_ID},
              ${`progressive-overload-gap-${weekOffset}`},
              'strength', 'strength_training', NULL,
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

    expect(activities.items.map((activity) => activity.canonical_type)).toEqual(
      expect.arrayContaining(["strength"]),
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

  it("unions member sets without double-counting exact mirrors for every resolved identity", async () => {
    const activityRepository = new ActivityRepository(testContext.db, TEST_USER_ID, "UTC");
    const strengthRepository = new StrengthRepository(testContext.db, TEST_USER_ID, "UTC");
    const volumeBefore = await strengthRepository.getVolumeOverTime(30);
    const totalBefore = volumeBefore.reduce(
      (totals, week) => ({
        setCount: totals.setCount + week.toDetail().setCount,
        totalVolumeKg: totals.totalVolumeKg + week.toDetail().totalVolumeKg,
        workoutCount: totals.workoutCount + week.toDetail().workoutCount,
      }),
      { setCount: 0, totalVolumeKg: 0, workoutCount: 0 },
    );

    await testContext.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES
            ('strength_union_strong', 'Strong', ${TEST_USER_ID}),
            ('strength_union_mirror', 'Strength Mirror', ${TEST_USER_ID})
          ON CONFLICT (id) DO NOTHING`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.provider_priority (provider_id, priority)
          VALUES ('strength_union_strong', 20), ('strength_union_mirror', 5)
          ON CONFLICT (provider_id) DO UPDATE SET priority = EXCLUDED.priority`,
    );
    const exercises = await executeWithSchema(
      testContext.db,
      z.object({ id: z.string().uuid(), name: z.string() }),
      sql`INSERT INTO fitness.exercise (name, muscle_groups, equipment)
          VALUES
            ('Task 8 Deadlift', ARRAY['back', 'glutes', 'hamstrings']::text[], 'barbell'),
            ('Task 8 Bench Press', ARRAY['chest', 'triceps']::text[], 'barbell')
          RETURNING id, name`,
    );
    const deadliftId = exercises.find((exercise) => exercise.name === "Task 8 Deadlift")?.id;
    const benchPressId = exercises.find((exercise) => exercise.name === "Task 8 Bench Press")?.id;
    if (!deadliftId || !benchPressId) throw new Error("Task 8 exercises were not created");

    const strongRows = await executeWithSchema(
      testContext.db,
      activityIdentityRowSchema,
      sql`INSERT INTO fitness.activity (
            provider_id, user_id, external_id, canonical_type, provider_type,
            started_at, ended_at, name, source_name
          ) VALUES (
            'strength_union_strong', ${TEST_USER_ID}, 'task-8-strong-member',
            'strength', 'strength_training', CURRENT_TIMESTAMP - INTERVAL '12 hours',
            CURRENT_TIMESTAMP - INTERVAL '11 hours', 'Task 8 union workout', 'Strong'
          ) RETURNING id, group_id`,
    );
    const strongMember = strongRows[0];
    if (!strongMember) throw new Error("Task 8 Strong member was not created");
    const mirrorRows = await executeWithSchema(
      testContext.db,
      activityIdentityRowSchema,
      sql`INSERT INTO fitness.activity (
            group_id, provider_id, user_id, external_id, canonical_type, provider_type,
            started_at, ended_at, name, source_name
          ) VALUES (
            ${strongMember.group_id}::uuid, 'strength_union_mirror', ${TEST_USER_ID},
            'task-8-mirror-member', 'strength', 'strength_training',
            CURRENT_TIMESTAMP - INTERVAL '12 hours', CURRENT_TIMESTAMP - INTERVAL '11 hours',
            'Task 8 union workout', 'Strength Mirror'
          ) RETURNING id, group_id`,
    );
    const mirrorMember = mirrorRows[0];
    if (!mirrorMember) throw new Error("Task 8 mirror member was not created");

    await testContext.db.execute(
      sql`INSERT INTO fitness.strength_set (
            activity_id, exercise_id, exercise_index, set_index, set_type,
            weight_kg, reps, duration_seconds, rpe, notes
          ) VALUES
            (${strongMember.id}, ${deadliftId}, 0, 0, 'working', 100, 5, NULL, NULL, NULL),
            (${strongMember.id}, ${deadliftId}, 0, 1, 'rest', NULL, NULL, 0, NULL, NULL),
            (${mirrorMember.id}, ${deadliftId}, 0, 0, 'working', 100, 5, NULL, 8, 'Complete mirror'),
            (${mirrorMember.id}, ${deadliftId}, 0, 2, 'working', 110, 3, NULL, 9, NULL),
            (${mirrorMember.id}, ${benchPressId}, 0, 0, 'working', 50, 10, NULL, 7, NULL)`,
    );
    const historicalAlias = "00000000-0000-4000-8000-000000000808";
    await testContext.db.execute(
      sql`INSERT INTO fitness.activity_group_alias (alias_id, group_id, user_id, reason)
          VALUES (${historicalAlias}::uuid, ${strongMember.group_id}::uuid, ${TEST_USER_ID}, 'merge')`,
    );

    const primaryRows = await executeWithSchema(
      testContext.db,
      primaryMemberRowSchema,
      sql`SELECT primary_activity_id::text AS primary_activity_id
          FROM fitness.v_activity
          WHERE id = ${strongMember.group_id}::uuid`,
    );
    expect(primaryRows[0]?.primary_activity_id).toBe(mirrorMember.id);

    const detailsByLookup = await Promise.all(
      [strongMember.group_id, strongMember.id, mirrorMember.id, historicalAlias].map(
        async (lookupId) => {
          const activity = await activityRepository.findById(lookupId);
          if (!activity) throw new Error(`Task 8 activity lookup failed: ${lookupId}`);
          return {
            activity,
            exercises: (await strengthRepository.getExercisesForActivity(activity.id)).map(
              (exercise) => exercise.toDetail(),
            ),
          };
        },
      ),
    );

    expect(detailsByLookup.map(({ activity }) => activity.id)).toEqual([
      strongMember.group_id,
      strongMember.group_id,
      strongMember.group_id,
      strongMember.group_id,
    ]);
    expect(detailsByLookup[1]?.activity.resolved_from).toBe(strongMember.id);
    expect(detailsByLookup.map(({ exercises }) => exercises)).toEqual([
      detailsByLookup[0]?.exercises,
      detailsByLookup[0]?.exercises,
      detailsByLookup[0]?.exercises,
      detailsByLookup[0]?.exercises,
    ]);
    expect(detailsByLookup[0]?.exercises.map((exercise) => exercise.exerciseName)).toEqual([
      "Task 8 Bench Press",
      "Task 8 Deadlift",
    ]);
    expect(detailsByLookup[0]?.exercises[1]?.sets).toEqual([
      expect.objectContaining({ notes: "Complete mirror", setIndex: 0, weightKg: 100, reps: 5 }),
      expect.objectContaining({ durationSeconds: 0, setIndex: 1, setType: "rest" }),
      expect.objectContaining({ setIndex: 2, weightKg: 110, reps: 3 }),
    ]);

    const summary = (await strengthRepository.getWorkoutSummaries(30)).find(
      (workout) => workout.toDetail().name === "Task 8 union workout",
    );
    expect(summary?.toDetail()).toMatchObject({
      exerciseCount: 2,
      totalSets: 3,
      totalVolumeKg: 1330,
    });
    const volumeAfter = await strengthRepository.getVolumeOverTime(30);
    const totalAfter = volumeAfter.reduce(
      (totals, week) => ({
        setCount: totals.setCount + week.toDetail().setCount,
        totalVolumeKg: totals.totalVolumeKg + week.toDetail().totalVolumeKg,
        workoutCount: totals.workoutCount + week.toDetail().workoutCount,
      }),
      { setCount: 0, totalVolumeKg: 0, workoutCount: 0 },
    );
    expect({
      setCount: totalAfter.setCount - totalBefore.setCount,
      totalVolumeKg: totalAfter.totalVolumeKg - totalBefore.totalVolumeKg,
      workoutCount: totalAfter.workoutCount - totalBefore.workoutCount,
    }).toEqual({ setCount: 3, totalVolumeKg: 1330, workoutCount: 1 });
  });
});
