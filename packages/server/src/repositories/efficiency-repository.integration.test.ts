import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ChartRange } from "../lib/chart-range.ts";
import {
  createClickHouseTestActivitySensorStore,
  seedClickHouseMetricStreamRows,
} from "../routers/clickhouse-integration-test-helpers.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { EfficiencyRepository } from "./efficiency-repository.ts";

const ACTIVITY_ID = "19970000-0000-4000-8000-000000000001";
const fixtureCountSchema = z.object({
  sensor_rows: z.coerce.number(),
  serving_rows: z.coerce.number(),
});

describe("EfficiencyRepository ClickHouse serving model", () => {
  let testContext: TestContext;
  let sensorStore: ActivitySensorStore;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    await testContext.db.execute(sql`
      UPDATE fitness.user_profile
      SET max_hr = 190
      WHERE id = ${TEST_USER_ID}
    `);
    await testContext.db.execute(sql`
      INSERT INTO fitness.provider (id, name, user_id)
      VALUES ('polarization_fixture', 'Polarization Fixture', ${TEST_USER_ID})
      ON CONFLICT DO NOTHING
    `);

    const startedAt = new Date(Date.now() - 2 * 86_400_000);
    const endedAt = new Date(startedAt.getTime() + 3_600_000);
    await testContext.db.execute(sql`
      INSERT INTO fitness.activity (
        id, provider_id, user_id, external_id, canonical_type, provider_type, started_at, ended_at, name
      ) VALUES (
        ${ACTIVITY_ID},
        'polarization_fixture',
        ${TEST_USER_ID},
        'polarization-empty-serving-model',
        'cycling',
        'cycling',
        ${startedAt.toISOString()},
        ${endedAt.toISOString()},
        'Polarization Fixture Ride'
      )
    `);

    sensorStore = await createClickHouseTestActivitySensorStore(testContext);
    await seedClickHouseMetricStreamRows(
      testContext,
      [120, 160, 180].map((heartRate, sampleIndex) => ({
        activityId: ACTIVITY_ID,
        userId: TEST_USER_ID,
        recordedAt: new Date(startedAt.getTime() + sampleIndex * 1_000).toISOString(),
        channel: "heart_rate",
        providerId: "polarization_fixture",
        sourceType: "api",
        scalar: heartRate,
      })),
    );
  }, 120_000);

  afterAll(async () => {
    await testContext?.cleanup();
  });

  it("does not scan raw sensor models when the serving table is empty", async () => {
    const fixtureCounts = await sensorStore.query(
      fixtureCountSchema,
      `SELECT
        (SELECT count()
         FROM analytics.deduped_sensor
         WHERE user_id = {userId:UUID} AND is_deleted = 0) AS sensor_rows,
        (SELECT count()
         FROM analytics.activity_polarization_zones FINAL
         WHERE user_id = {userId:UUID} AND is_deleted = 0) AS serving_rows`,
      { userId: TEST_USER_ID },
    );
    expect(fixtureCounts).toEqual([{ sensor_rows: 3, serving_rows: 0 }]);

    const querySpy = vi.spyOn(sensorStore, "query");
    const repository = new EfficiencyRepository(testContext.db, TEST_USER_ID, "UTC", sensorStore);

    const result = await repository.getPolarizationTrend(ChartRange.fromDays(90));

    expect(result).toMatchObject({ maxHr: null, weeks: [] });
    expect(querySpy).toHaveBeenCalledTimes(1);
    const queryText = querySpy.mock.calls[0]?.[1];
    expect(queryText).toContain("analytics.activity_polarization_zones");
    expect(queryText).not.toContain("analytics.deduped_sensor");
    expect(queryText).not.toContain("analytics.activity_summary");
  });
});
