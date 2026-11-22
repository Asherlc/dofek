import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { reconcileActivityGroups } from "../../../../src/db/activity-group-reconciliation.ts";
import {
  createTestBarrier,
  setupTestDatabase,
  type TestContext,
} from "../../../../src/db/test-helpers.ts";
import { executeWithSchema } from "../../../../src/db/typed-sql.ts";
import { appleHealthWorkoutExternalId, processWorkouts } from "./health-kit-sync-processors.ts";
import { readActivityProjectionForTest } from "./test-helpers.ts";

const WORKOUT_SYNC_WINDOW = {
  windowStart: "2025-06-01T00:00:00.000Z",
  windowEnd: "2025-07-01T00:00:00.000Z",
};

describe("HealthKit workout grouping transactions", () => {
  let testCtx: TestContext;

  beforeAll(async () => {
    testCtx = await setupTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await testCtx?.cleanup();
  });

  it("waits for activity grouping ownership before locking workouts for absence reconciliation", async () => {
    const userId = "00000000-0000-0000-0000-000000000001";
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name) VALUES ('whoop', 'WHOOP'), ('apple_health', 'Apple Health')
            ON CONFLICT (id) DO NOTHING`,
    );
    await testCtx.db.execute(
      sql`INSERT INTO fitness.activity
              (user_id, provider_id, external_id, canonical_type, provider_type, started_at, ended_at)
            VALUES
              (${userId}, 'whoop', 'locked-healthkit-native-first', 'walking', 'walking',
                '2025-06-30T10:00:00Z', '2025-06-30T11:00:00Z'),
              (${userId}, 'whoop', 'locked-healthkit-native-second', 'walking', 'walking',
                '2025-06-30T12:00:00Z', '2025-06-30T13:00:00Z')`,
    );
    const bridge = {
      uuid: "locked-healthkit-bridge",
      workoutType: "52",
      startDate: "2025-06-30T10:00:00Z",
      endDate: "2025-06-30T13:00:00Z",
      duration: 10800,
      totalDistance: null,
      sourceName: "WHOOP",
      sourceBundle: "com.whoop.app",
    };
    const retained = {
      ...bridge,
      uuid: "locked-healthkit-retained-workout",
      startDate: "2025-06-29T14:00:00Z",
      endDate: "2025-06-29T15:00:00Z",
      duration: 3600,
    };
    const initial = await processWorkouts(
      testCtx.db,
      userId,
      [bridge, retained],
      WORKOUT_SYNC_WINDOW,
    );
    expect(initial).toBe(2);

    const locked = createTestBarrier();
    const release = createTestBarrier();
    let holderPid = 0;
    const holder = testCtx.db.transaction(async (transaction) => {
      await reconcileActivityGroups(transaction, userId);
      const [backend] = await transaction.execute<{ pid: number }>(
        sql`SELECT pg_backend_pid() AS pid`,
      );
      holderPid = backend?.pid ?? 0;
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const upload = processWorkouts(testCtx.db, userId, [retained], WORKOUT_SYNC_WINDOW);
    try {
      await expect
        .poll(async () => {
          const [state] = await testCtx.db.execute<{ waiting: boolean }>(sql`SELECT EXISTS (
              SELECT 1
              FROM pg_locks AS waiting
              JOIN pg_locks AS holding
                ON holding.locktype = waiting.locktype
                AND holding.database IS NOT DISTINCT FROM waiting.database
                AND holding.classid IS NOT DISTINCT FROM waiting.classid
                AND holding.objid IS NOT DISTINCT FROM waiting.objid
                AND holding.objsubid IS NOT DISTINCT FROM waiting.objsubid
              JOIN pg_stat_activity AS activity ON activity.pid = waiting.pid
              WHERE waiting.locktype = 'advisory' AND NOT waiting.granted
                AND holding.granted AND holding.pid = ${holderPid}
                AND activity.datname = current_database() AND activity.wait_event = 'advisory'
            ) AS waiting`);
          return state?.waiting;
        })
        .toBe(true);
      const observed = await testCtx.db.transaction((transaction) =>
        transaction.execute(sql`SELECT external_id FROM fitness.activity
            WHERE user_id = ${userId} AND external_id = 'hk:workout:locked-healthkit-bridge'
            FOR UPDATE NOWAIT`),
      );
      expect(observed).toEqual([{ external_id: "hk:workout:locked-healthkit-bridge" }]);
    } finally {
      release.resolve();
      await Promise.all([holder, upload]);
    }
    expect(await upload).toBe(1);
  });
});

describe("Apple Health reported workout effort", () => {
  let testCtx: TestContext;
  const userId = "00000000-0000-0000-0000-000000000001";

  const effortSample = (value: number) => ({
    uuid: "c0ffee11-1111-4111-8111-111111111111",
    value,
    startDate: "2025-06-15T10:05:00.000Z",
    endDate: "2025-06-15T10:05:30.000Z",
    sourceName: "Apple Watch",
    sourceBundle: "com.apple.health",
  });

  const cyclingWorkout = (
    uuid: string,
    workoutEffort?: ReturnType<typeof effortSample>,
    day = "15",
  ) => ({
    uuid,
    workoutType: "13",
    startDate: `2025-06-${day}T10:00:00.000Z`,
    endDate: `2025-06-${day}T11:00:00.000Z`,
    duration: 3600,
    totalDistance: 30000,
    sourceName: "Apple Watch",
    sourceBundle: "com.apple.health",
    ...(workoutEffort ? { workoutEffort } : {}),
  });

  beforeAll(async () => {
    testCtx = await setupTestDatabase();
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name) VALUES ('whoop', 'WHOOP'), ('apple_health', 'Apple Health')
            ON CONFLICT (id) DO NOTHING`,
    );
  }, 60_000);

  afterAll(async () => {
    await testCtx?.cleanup();
  });

  async function readProjection(uuid: string) {
    const [row] = await executeWithSchema(
      testCtx.db,
      z.object({ id: z.guid() }),
      sql`SELECT id::text AS id FROM fitness.activity
          WHERE user_id = ${userId} AND provider_id = 'apple_health'
            AND external_id = ${appleHealthWorkoutExternalId(uuid)}`,
    );
    expect(row).toBeDefined();
    return readActivityProjectionForTest(testCtx.db, row.id);
  }

  it("imports a reported 7, adopts an edited 8, and preserves both on a legacy omission", async () => {
    const uuid = "effort-edit-ride";
    const first = effortSample(7);
    expect(
      await processWorkouts(testCtx.db, userId, [cyclingWorkout(uuid, first)], WORKOUT_SYNC_WINDOW),
    ).toBe(1);

    let [projection] = await readProjection(uuid);
    expect(projection?.perceived_exertion).toBe(7);
    expect(projection?.raw.workoutEffort).toMatchObject({
      uuid: first.uuid,
      value: 7,
      startDate: first.startDate,
      endDate: first.endDate,
      sourceName: first.sourceName,
      sourceBundle: first.sourceBundle,
    });

    const edited = { ...effortSample(8), uuid: "c0ffee22-2222-4222-8222-222222222222" };
    await processWorkouts(testCtx.db, userId, [cyclingWorkout(uuid, edited)], WORKOUT_SYNC_WINDOW);
    [projection] = await readProjection(uuid);
    expect(projection?.perceived_exertion).toBe(8);
    expect(projection?.raw.workoutEffort).toMatchObject({ uuid: edited.uuid, value: 8 });

    // An older client or an additive workout context omits effort: neither the raw
    // sample evidence nor the canonical numeric value may be cleared.
    const legacyUpload = { ...cyclingWorkout(uuid), totalDistance: 31000 };
    await processWorkouts(testCtx.db, userId, [legacyUpload], WORKOUT_SYNC_WINDOW);
    [projection] = await readProjection(uuid);
    expect(projection?.perceived_exertion).toBe(8);
    expect(projection?.raw.totalDistance).toBe(31000);
    expect(projection?.raw.workoutEffort).toMatchObject({
      uuid: edited.uuid,
      value: 8,
      startDate: edited.startDate,
      endDate: edited.endDate,
      sourceName: edited.sourceName,
      sourceBundle: edited.sourceBundle,
    });
  });

  it("leaves a workout without a reported rating empty", async () => {
    const uuid = "effort-absent-ride";
    await processWorkouts(
      testCtx.db,
      userId,
      [cyclingWorkout(uuid, undefined, "16")],
      WORKOUT_SYNC_WINDOW,
    );

    const [projection] = await readProjection(uuid);
    expect(projection?.perceived_exertion).toBeNull();
    expect(projection?.raw.workoutEffort).toBeUndefined();
  });

  it("keeps the cycling effort import scoped to cycling activities", async () => {
    const uuid = "effort-running-workout";
    const run = { ...cyclingWorkout(uuid, effortSample(7)), workoutType: "37" };
    await processWorkouts(testCtx.db, userId, [run], WORKOUT_SYNC_WINDOW);

    const [projection] = await readProjection(uuid);
    expect(projection?.perceived_exertion).toBeNull();
    expect(projection?.raw.workoutEffort).toBeUndefined();
  });

  it("recovers a qualified rating from the Apple Health member of a deduplicated group", async () => {
    const uuid = "effort-grouped-ride";
    const effort = effortSample(9);
    await testCtx.db.execute(
      sql`INSERT INTO fitness.activity
              (user_id, provider_id, external_id, canonical_type, provider_type, started_at, ended_at)
            VALUES (${userId}, 'whoop', 'grouped-ride-whoop', 'cycling', 'cycling',
              '2025-06-17T10:00:00Z', '2025-06-17T11:00:00Z')`,
    );
    await processWorkouts(
      testCtx.db,
      userId,
      [cyclingWorkout(uuid, effort, "17")],
      WORKOUT_SYNC_WINDOW,
    );

    const [projection] = await readProjection(uuid);
    expect(projection?.member_activity_ids).toHaveLength(2);
    expect(projection?.perceived_exertion).toBe(9);
    expect(projection?.raw.workoutEffort).toMatchObject({
      uuid: effort.uuid,
      value: 9,
      sourceBundle: effort.sourceBundle,
    });
  });

  it("omits Apple sample provenance when another grouped member supplies the rating", async () => {
    const uuid = "effort-grouped-legacy-ride";
    const effort = effortSample(9);
    await testCtx.db.execute(sql`INSERT INTO fitness.provider_field_priority
          (provider_id, field_key, priority) VALUES ('whoop', 'activity.perceived_exertion', 0)
          ON CONFLICT (provider_id, field_key) DO UPDATE SET priority = excluded.priority`);
    await testCtx.db.execute(sql`INSERT INTO fitness.activity
          (user_id, provider_id, external_id, canonical_type, provider_type, started_at, ended_at,
           perceived_exertion)
        VALUES (${userId}, 'whoop', 'legacy-effort-ride', 'cycling', 'cycling',
          '2025-06-16T10:00:00Z', '2025-06-16T11:00:00Z', 7)`);
    await processWorkouts(
      testCtx.db,
      userId,
      [
        {
          ...cyclingWorkout(uuid, effort),
          startDate: "2025-06-16T10:00:00Z",
          endDate: "2025-06-16T11:00:00Z",
        },
      ],
      WORKOUT_SYNC_WINDOW,
    );

    const [projection] = await readProjection(uuid);
    expect(projection?.member_activity_ids).toHaveLength(2);
    expect(projection?.perceived_exertion).toBe(7);
    expect(projection?.raw.workoutEffort).toBeUndefined();
  });
});
