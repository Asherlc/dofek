import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { DerivedCardioRepository } from "./derived-cardio-repository.ts";

let testContext: TestContext | null = null;

afterEach(async () => {
  await testContext?.cleanup();
  testContext = null;
});

// Task 3 creates the SQL views these tests exercise.
describe.skip("DerivedCardioRepository integration pending derived SQL views", () => {
  it("derives resting HR from sleep-window heart-rate samples", async () => {
    testContext = await setupTestDatabase();
    const repo = new DerivedCardioRepository(testContext.db, {
      userId: TEST_USER_ID,
      timezone: "UTC",
    });

    await testContext.db.execute(sql`INSERT INTO fitness.provider (id, name, user_id)
      VALUES ('test_provider', 'Test Provider', ${TEST_USER_ID})
      ON CONFLICT (id) DO NOTHING`);
    await testContext.db.execute(sql`INSERT INTO fitness.sleep_session
      (provider_id, user_id, external_id, started_at, ended_at, duration_minutes, is_nap)
      VALUES ('test_provider', ${TEST_USER_ID}, 'sleep-1', '2026-04-27T23:00:00Z', '2026-04-28T07:00:00Z', 480, false)`);

    for (let index = 0; index < 30; index++) {
      await testContext.db.execute(sql`INSERT INTO fitness.metric_stream
        (recorded_at, user_id, provider_id, source_type, channel, scalar)
        VALUES (${`2026-04-28T00:${String(index).padStart(2, "0")}:00Z`}, ${TEST_USER_ID}, 'test_provider', 'api', 'heart_rate', ${50 + (index % 10)})`);
    }

    const rows = await repo.getDailyRestingHeartRates("2026-04-28", 7);

    expect(rows).toContainEqual({ date: "2026-04-28", restingHr: 52 });
  });

  it("returns null when resting HR has fewer than 30 sleep-window samples", async () => {
    testContext = await setupTestDatabase();
    const repo = new DerivedCardioRepository(testContext.db, {
      userId: TEST_USER_ID,
      timezone: "UTC",
    });

    await testContext.db.execute(sql`INSERT INTO fitness.provider (id, name, user_id)
      VALUES ('test_provider', 'Test Provider', ${TEST_USER_ID})
      ON CONFLICT (id) DO NOTHING`);
    await testContext.db.execute(sql`INSERT INTO fitness.sleep_session
      (provider_id, user_id, external_id, started_at, ended_at, duration_minutes, is_nap)
      VALUES ('test_provider', ${TEST_USER_ID}, 'sleep-1', '2026-04-27T23:00:00Z', '2026-04-28T07:00:00Z', 480, false)`);
    await testContext.db.execute(sql`INSERT INTO fitness.metric_stream
      (recorded_at, user_id, provider_id, source_type, channel, scalar)
      VALUES ('2026-04-28T00:00:00Z', ${TEST_USER_ID}, 'test_provider', 'api', 'heart_rate', 45)`);

    await expect(repo.getAverageRestingHeartRate("2026-04-28", 7)).resolves.toBeNull();
  });
});
