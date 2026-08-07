import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
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
    const repo = new DerivedCardioRepository(
      testContext.db,
      {
        userId: TEST_USER_ID,
        timezone: "UTC",
      },
      { query: async () => [{ date: "2026-04-28", resting_hr: 50 }] },
    );

    await testContext.db.execute(sql`INSERT INTO fitness.provider (id, name, user_id)
      VALUES ('test_provider', 'Test Provider', ${TEST_USER_ID})
      ON CONFLICT (id) DO NOTHING`);
    await testContext.db.execute(sql`INSERT INTO fitness.sleep_session
      (provider_id, user_id, external_id, started_at, ended_at, duration_minutes, sleep_type)
      VALUES ('test_provider', ${TEST_USER_ID}, 'sleep-1', '2026-04-27T23:00:00Z', '2026-04-28T07:00:00Z', 480, 'sleep')`);

    await refreshRestingHeartRateViews();

    const rows = await repo.getDailyRestingHeartRates("2026-04-28", 7);

    expect(rows).toContainEqual({ date: "2026-04-28", restingHr: 50 });
  });

  it("returns null when resting HR has fewer than 30 sleep-window samples", async () => {
    testContext = await setupTestDatabase();
    const repo = new DerivedCardioRepository(
      testContext.db,
      {
        userId: TEST_USER_ID,
        timezone: "UTC",
      },
      { query: async () => [] },
    );

    await testContext.db.execute(sql`INSERT INTO fitness.provider (id, name, user_id)
      VALUES ('test_provider', 'Test Provider', ${TEST_USER_ID})
      ON CONFLICT (id) DO NOTHING`);
    await testContext.db.execute(sql`INSERT INTO fitness.sleep_session
      (provider_id, user_id, external_id, started_at, ended_at, duration_minutes, sleep_type)
      VALUES ('test_provider', ${TEST_USER_ID}, 'sleep-1', '2026-04-27T23:00:00Z', '2026-04-28T07:00:00Z', 480, 'sleep')`);

    await refreshRestingHeartRateViews();

    await expect(repo.getAverageRestingHeartRate("2026-04-28", 7)).resolves.toBeNull();
  });

  it("averages all qualifying cycling VO2 max estimates", async () => {
    testContext = await setupTestDatabase();
    const repo = new DerivedCardioRepository(
      testContext.db,
      {
        userId: TEST_USER_ID,
        timezone: "UTC",
      },
      {
        getVo2MaxEstimates: async () => [
          {
            activity_id: "00000000-0000-4000-8000-000000000101",
            activity_date: "2026-04-10",
            method: "cycling_power",
            vo2max: (300 / 75) * 10.8 + 7,
          },
          {
            activity_id: "00000000-0000-4000-8000-000000000102",
            activity_date: "2026-04-11",
            method: "cycling_power",
            vo2max: (250 / 75) * 10.8 + 7,
          },
        ],
        query: async () => [],
        getActivitySummaries: async () => [],
        getPowerCurveSamples: async () => [],
        getNormalizedPowerSamples: async () => [],
        getHeartRateCurveRows: async () => [],
        getPaceCurveRows: async () => [],
        getStream: async () => [],
        getHeartRateZoneSeconds: async () => [],
        getPowerZoneSeconds: async () => [],
      },
    );

    await testContext.db.execute(sql`INSERT INTO fitness.provider (id, name, user_id)
      VALUES ('test_provider', 'Test Provider', ${TEST_USER_ID})
      ON CONFLICT (id) DO NOTHING`);

    for (const [activityId, startedAt] of [
      ["00000000-0000-4000-8000-000000000101", "2026-04-10T12:00:00Z"],
      ["00000000-0000-4000-8000-000000000102", "2026-04-11T12:00:00Z"],
    ] as const) {
      const endedAt = new Date(new Date(startedAt).getTime() + 300_000).toISOString();
      await testContext.db.execute(sql`INSERT INTO fitness.activity
        (id, provider_id, user_id, external_id, canonical_type, provider_type, started_at, ended_at)
        VALUES (${activityId}, 'test_provider', ${TEST_USER_ID}, ${activityId}, 'cycling', 'cycling', ${startedAt}, ${endedAt})`);
    }

    const result = await repo.getVo2MaxAverage("2026-04-28", 90);

    expect(result?.sampleCount).toBe(2);
    expect(result?.value).toBeCloseTo(((300 / 75) * 10.8 + 7 + (250 / 75) * 10.8 + 7) / 2, 1);
  });
});

async function refreshRestingHeartRateViews() {
  if (testContext === null) {
    throw new Error("Test database has not been initialized");
  }
}
