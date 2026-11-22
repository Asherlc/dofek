import { randomUUID } from "node:crypto";
import { strengthExerciseIdentityKey } from "@dofek/training/training";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { StrengthExerciseOrderRepository } from "./strength-exercise-order-repository.ts";

describe("StrengthExerciseOrderRepository Postgres integration", () => {
  let context: TestContext;
  const otherUserId = randomUUID();

  const crimpdProvider = "crimpd";
  const strongProvider = `strong-${randomUUID()}`;

  const benchExerciseId = randomUUID();
  const pullUpExerciseId = randomUUID();

  const canonicalActivityId1 = randomUUID();
  const strongMemberId1 = randomUUID();

  const canonicalActivityId2 = randomUUID();

  const otherUserActivityId = randomUUID();

  beforeAll(async () => {
    context = await setupTestDatabase();

    // Create other user
    await context.db.execute(sql`
      INSERT INTO fitness.user_profile (id, name)
      VALUES (${otherUserId}::uuid, 'Other User')
      ON CONFLICT DO NOTHING
    `);

    // Ensure providers exist
    await context.db.execute(sql`
      INSERT INTO fitness.provider (id, name, user_id)
      VALUES
        (${crimpdProvider}, 'Crimpd', ${TEST_USER_ID}::uuid),
        (${strongProvider}, 'Strong', ${TEST_USER_ID}::uuid)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
    `);

    // Exercises
    await context.db.execute(sql`
      INSERT INTO fitness.exercise (id, name, muscle_groups, equipment)
      VALUES
        (${benchExerciseId}::uuid, 'Order Test Bench', ARRAY['chest'], 'barbell'),
        (${pullUpExerciseId}::uuid, 'Order Test Pull Up', ARRAY['back'], NULL)
      ON CONFLICT (id) DO NOTHING
    `);

    // Canonical activity 1 (TEST_USER_ID, 2026-05-01):
    // Contains Crimpd member AND Strong member!
    // Bench Press is position 1, Pull Up is position 2.
    // Crimpd raw-only sets have NULL weight_kg!
    await context.db.execute(sql`
      INSERT INTO fitness.activity (
        id, group_id, provider_id, user_id, external_id, canonical_type, provider_type,
        started_at, ended_at, name, source_name, raw, timezone, local_time_source
      ) VALUES
        (${canonicalActivityId1}::uuid, ${canonicalActivityId1}::uuid, ${crimpdProvider}, ${TEST_USER_ID}::uuid, 'crimpd-act-1',
          'strength', 'strength', '2026-05-01T10:00:00Z', '2026-05-01T11:00:00Z',
          'Session 1', 'Crimpd', '{"LOG_ID":"crimpd-act-1"}'::jsonb, 'UTC', 'provider_timezone'),
        (${strongMemberId1}::uuid, ${canonicalActivityId1}::uuid, ${strongProvider}, ${TEST_USER_ID}::uuid, 'strong-act-1',
          'strength', 'strength', '2026-05-01T10:00:00Z', '2026-05-01T11:00:00Z',
          'Session 1 Strong', 'Strong', '{}'::jsonb, 'UTC', 'provider_timezone')
    `);

    // Sets for Crimpd member 1 (NULL weight_kg for Crimpd raw-only):
    await context.db.execute(sql`
      INSERT INTO fitness.strength_set (
        activity_id, exercise_id, exercise_index, set_index, set_type,
        weight_kg, reps, raw
      ) VALUES
        (${canonicalActivityId1}::uuid, ${benchExerciseId}::uuid, 0, 0, 'working',
          NULL, 5, '{"LOG_ID":"crimpd-act-1","ACTIVITY_ORDER":"1","SET_ORDER":"1","COMPLETE":"true","RESISTANCE":"80","WEIGHT_UNIT":"KG"}'::jsonb),
        (${canonicalActivityId1}::uuid, ${pullUpExerciseId}::uuid, 1, 0, 'working',
          NULL, 5, '{"LOG_ID":"crimpd-act-1","ACTIVITY_ORDER":"2","SET_ORDER":"1","COMPLETE":"true","RESISTANCE":"20","WEIGHT_UNIT":"KG"}'::jsonb)
    `);

    // Sets for Strong member 1 (must be excluded from Crimpd order!):
    await context.db.execute(sql`
      INSERT INTO fitness.strength_set (
        activity_id, exercise_id, exercise_index, set_index, set_type,
        weight_kg, reps, raw
      ) VALUES
        (${strongMemberId1}::uuid, ${pullUpExerciseId}::uuid, 0, 0, 'working',
          100, 5, '{"weight":100}'::jsonb)
    `);

    // Canonical activity 2 (TEST_USER_ID, 2026-06-01):
    // Pull Up is position 1 (earlier than session 1!).
    await context.db.execute(sql`
      INSERT INTO fitness.activity (
        id, group_id, provider_id, user_id, external_id, canonical_type, provider_type,
        started_at, ended_at, name, source_name, raw, timezone, local_time_source
      ) VALUES
        (${canonicalActivityId2}::uuid, ${canonicalActivityId2}::uuid, ${crimpdProvider}, ${TEST_USER_ID}::uuid, 'crimpd-act-2',
          'strength', 'strength', '2026-06-01T10:00:00Z', '2026-06-01T11:00:00Z',
          'Session 2', 'Crimpd', '{"LOG_ID":"crimpd-act-2"}'::jsonb, 'UTC', 'provider_timezone')
    `);

    await context.db.execute(sql`
      INSERT INTO fitness.strength_set (
        activity_id, exercise_id, exercise_index, set_index, set_type,
        weight_kg, reps, raw
      ) VALUES
        (${canonicalActivityId2}::uuid, ${pullUpExerciseId}::uuid, 0, 0, 'working',
          NULL, 5, '{"LOG_ID":"crimpd-act-2","ACTIVITY_ORDER":"1","SET_ORDER":"1","COMPLETE":"true","RESISTANCE":"25","WEIGHT_UNIT":"KG"}'::jsonb)
    `);

    // Activity for Other User:
    // Must have position-1 Bench and position-2 Pull Up so Pull Up has a baseline for other user!
    await context.db.execute(sql`
      INSERT INTO fitness.activity (
        id, group_id, provider_id, user_id, external_id, canonical_type, provider_type,
        started_at, ended_at, name, source_name, raw, timezone, local_time_source
      ) VALUES
        (${otherUserActivityId}::uuid, ${otherUserActivityId}::uuid, ${crimpdProvider}, ${otherUserId}::uuid, 'crimpd-act-other',
          'strength', 'strength', '2026-05-01T10:00:00Z', '2026-05-01T11:00:00Z',
          'Session Other', 'Crimpd', '{"LOG_ID":"crimpd-act-other"}'::jsonb, 'UTC', 'provider_timezone')
    `);
    await context.db.execute(sql`
      INSERT INTO fitness.strength_set (
        activity_id, exercise_id, exercise_index, set_index, set_type,
        weight_kg, reps, raw
      ) VALUES
        (${otherUserActivityId}::uuid, ${benchExerciseId}::uuid, 0, 0, 'working',
          NULL, 5, '{"LOG_ID":"crimpd-act-other","ACTIVITY_ORDER":"1","SET_ORDER":"1","COMPLETE":"true","RESISTANCE":"60","WEIGHT_UNIT":"KG"}'::jsonb),
        (${otherUserActivityId}::uuid, ${pullUpExerciseId}::uuid, 1, 0, 'working',
          NULL, 5, '{"LOG_ID":"crimpd-act-other","ACTIVITY_ORDER":"2","SET_ORDER":"1","COMPLETE":"true","RESISTANCE":"50","WEIGHT_UNIT":"KG"}'::jsonb)
    `);
  });

  afterAll(async () => {
    await context?.cleanup();
  });

  it("applies the finite date window and restricted access window to the real source rows", async () => {
    const pullUpKey = strengthExerciseIdentityKey({
      exerciseName: "Order Test Pull Up",
      equipment: null,
    });

    // Fixture workouts are 2026-05/06; the current date is later, so a 90-day window must exclude them.
    const repo = new StrengthExerciseOrderRepository(context.db, TEST_USER_ID, "UTC");
    const recentOnly = await repo.getExerciseOrders(90);
    expect(recentOnly.has(pullUpKey)).toBe(false);

    // A restricted window starting after the baseline date drops the baseline, so no comparison is reported.
    const restrictedRepo = new StrengthExerciseOrderRepository(context.db, TEST_USER_ID, "UTC", {
      kind: "restricted",
      paid: false,
      reason: "free_tier",
      startDate: "2026-05-15",
      endDateExclusive: "2026-12-31",
    });
    const restricted = await restrictedRepo.getExerciseOrders(null);
    expect(restricted.has(pullUpKey)).toBe(false);
  });

  it("extracts Crimpd order baseline and earlier session from real Postgres and excludes Strong/other user", async () => {
    const repo = new StrengthExerciseOrderRepository(context.db, TEST_USER_ID, "UTC");
    const orders = await repo.getExerciseOrders(null);

    const pullUpKey = strengthExerciseIdentityKey({
      exerciseName: "Order Test Pull Up",
      equipment: null,
    });
    const order = orders.get(pullUpKey);

    expect(order).toBeDefined();
    expect(order?.evidence).toEqual({
      source: "Crimpd",
      baseline: {
        activityId: canonicalActivityId1,
        date: "2026-05-01",
        position: 2,
        sets: [{ position: 1, resistance: 20, unit: "KG", reps: 5 }],
      },
      earlier: {
        activityId: canonicalActivityId2,
        date: "2026-06-01",
        position: 1,
        sets: [{ position: 1, resistance: 25, unit: "KG", reps: 5 }],
      },
    });

    // Verify other user did not leak:
    const otherUserRepo = new StrengthExerciseOrderRepository(context.db, otherUserId, "UTC");
    const otherOrders = await otherUserRepo.getExerciseOrders(null);
    expect(otherOrders.get(pullUpKey)?.evidence.baseline.activityId).toBe(otherUserActivityId);
  });
});
