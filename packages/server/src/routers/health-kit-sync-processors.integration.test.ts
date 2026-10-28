import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reconcileActivityGroups } from "../../../../src/db/activity-group-reconciliation.ts";
import {
  createTestBarrier,
  setupTestDatabase,
  type TestContext,
} from "../../../../src/db/test-helpers.ts";
import { processWorkouts } from "./health-kit-sync-processors.ts";

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
