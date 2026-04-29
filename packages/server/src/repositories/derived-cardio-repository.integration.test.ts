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

describe("DerivedCardioRepository integration", () => {
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
      (provider_id, user_id, external_id, started_at, ended_at, duration_minutes, sleep_type)
      VALUES ('test_provider', ${TEST_USER_ID}, 'sleep-1', '2026-04-27T23:00:00Z', '2026-04-28T07:00:00Z', 480, 'sleep')`);

    for (let index = 0; index < 30; index++) {
      await testContext.db.execute(sql`INSERT INTO fitness.metric_stream
        (recorded_at, user_id, provider_id, source_type, channel, scalar)
        VALUES (${`2026-04-28T00:${String(index).padStart(2, "0")}:00Z`}, ${TEST_USER_ID}, 'test_provider', 'api', 'heart_rate', ${50 + (index % 10)})`);
    }

    await refreshRestingHeartRateViews();

    const rows = await repo.getDailyRestingHeartRates("2026-04-28", 7);

    expect(rows).toContainEqual({ date: "2026-04-28", restingHr: 50 });
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
      (provider_id, user_id, external_id, started_at, ended_at, duration_minutes, sleep_type)
      VALUES ('test_provider', ${TEST_USER_ID}, 'sleep-1', '2026-04-27T23:00:00Z', '2026-04-28T07:00:00Z', 480, 'sleep')`);
    await testContext.db.execute(sql`INSERT INTO fitness.metric_stream
      (recorded_at, user_id, provider_id, source_type, channel, scalar)
      VALUES ('2026-04-28T00:00:00Z', ${TEST_USER_ID}, 'test_provider', 'api', 'heart_rate', 45)`);

    await refreshRestingHeartRateViews();

    await expect(repo.getAverageRestingHeartRate("2026-04-28", 7)).resolves.toBeNull();
  });

  it("averages all qualifying cycling VO2 max estimates", async () => {
    testContext = await setupTestDatabase();
    const repo = new DerivedCardioRepository(testContext.db, {
      userId: TEST_USER_ID,
      timezone: "UTC",
    });

    await testContext.db.execute(sql`INSERT INTO fitness.provider (id, name, user_id)
      VALUES ('test_provider', 'Test Provider', ${TEST_USER_ID})
      ON CONFLICT (id) DO NOTHING`);
    await testContext.db.execute(sql`INSERT INTO fitness.body_measurement
      (provider_id, user_id, external_id, recorded_at, weight_kg)
      VALUES ('test_provider', ${TEST_USER_ID}, 'weight-1', '2026-04-01T00:00:00Z', 75)`);

    for (const [activityId, startedAt, power] of [
      ["00000000-0000-4000-8000-000000000101", "2026-04-10T12:00:00Z", 300],
      ["00000000-0000-4000-8000-000000000102", "2026-04-11T12:00:00Z", 250],
    ] as const) {
      const endedAt = new Date(new Date(startedAt).getTime() + 300_000).toISOString();
      await testContext.db.execute(sql`INSERT INTO fitness.activity
        (id, provider_id, user_id, external_id, activity_type, started_at, ended_at)
        VALUES (${activityId}, 'test_provider', ${TEST_USER_ID}, ${activityId}, 'cycling', ${startedAt}, ${endedAt})`);
      for (let second = 0; second < 300; second++) {
        const recordedAt = new Date(new Date(startedAt).getTime() + second * 1000).toISOString();
        await testContext.db.execute(sql`INSERT INTO fitness.metric_stream
          (recorded_at, user_id, provider_id, source_type, channel, activity_id, scalar)
          VALUES (${recordedAt}, ${TEST_USER_ID}, 'test_provider', 'api', 'power', ${activityId}, ${power})`);
      }
    }

    await testContext.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.v_activity`);
    await testContext.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.v_body_measurement`);
    await testContext.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.deduped_sensor`);
    await testContext.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.derived_vo2max_estimates`);

    const result = await repo.getVo2MaxAverage("2026-04-28", 90);

    expect(result?.sampleCount).toBe(2);
    expect(result?.value).toBeCloseTo(((300 / 75) * 10.8 + 7 + (250 / 75) * 10.8 + 7) / 2, 1);
  });
});

async function refreshRestingHeartRateViews() {
  if (testContext === null) {
    throw new Error("Test database has not been initialized");
  }
  await testContext.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.v_sleep`);
  await testContext.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.deduped_sensor`);
  await testContext.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.derived_resting_heart_rate`);
}
