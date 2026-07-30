import { formatDateYmd } from "@dofek/format/format";
import { STRENGTH_ACTIVITY_TYPES } from "@dofek/training/training";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ActivityRepository } from "./activity-repository.ts";
import { StrengthRepository } from "./strength-repository.ts";

describe("StrengthRepository activity scope", () => {
  let testContext: TestContext;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    await testContext.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('strength_scope_test', 'Strength Scope Test', ${TEST_USER_ID})`,
    );
    const exerciseRows = await testContext.db.execute<{ id: string }>(
      sql`INSERT INTO fitness.exercise (name, muscle_groups, equipment)
          VALUES ('Scope Test Press', ARRAY['chest']::text[], 'barbell')
          RETURNING id`,
    );
    const exerciseId = exerciseRows[0]?.id;
    if (!exerciseId) throw new Error("Strength scope test exercise was not created");

    for (const [activityIndex, activityType] of STRENGTH_ACTIVITY_TYPES.entries()) {
      const activityRows = await testContext.db.execute<{ id: string }>(
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
});
