import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import {
  createClickHouseTestActivitySensorStore,
  seedClickHouseMetricStreamRows,
  syncClickHouseTestActivitySensorStore,
} from "../routers/clickhouse-integration-test-helpers.ts";
import { TrainingLoadRepository } from "./training-load-repository.ts";

describe("TrainingLoadRepository integration", () => {
  let testContext: TestContext;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await testContext?.cleanup();
  });

  it("executes against daily_strain and reports partial and complete window coverage", async () => {
    const userId = randomUUID();
    const providerId = `training-load-${userId}`;
    const activityId = randomUUID();

    await testContext.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name)
          VALUES (${userId}::uuid, 'Training Load Fixture')`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES (${providerId}, 'Training Load Provider', ${userId}::uuid)`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.activity (
            id, provider_id, user_id, external_id, canonical_type, provider_type,
            started_at, ended_at, name, raw
          ) VALUES (
            ${activityId}::uuid, ${providerId}, ${userId}::uuid, 'training-load-activity',
            'cycling', 'cycling', '2026-08-05T08:00:00Z', '2026-08-05T09:00:00Z',
            'Training Load Fixture Ride', '{}'::jsonb
          )`,
    );

    const store = await createClickHouseTestActivitySensorStore(testContext);
    await syncClickHouseTestActivitySensorStore(testContext);
    await seedClickHouseMetricStreamRows(testContext, [
      {
        activityId,
        userId,
        providerId,
        channel: "heart_rate",
        recordedAt: "2026-08-05T08:10:00Z",
        scalar: 120,
      },
      {
        activityId,
        userId,
        providerId,
        channel: "heart_rate",
        recordedAt: "2026-08-05T08:50:00Z",
        scalar: 160,
      },
    ]);

    const rows = await new TrainingLoadRepository(store, userId).listRange(
      "2026-08-05",
      "2026-09-01",
    );

    expect(rows).toHaveLength(28);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        date: "2026-08-05",
        workload_ratio: null,
        coverage: { acute_window_days: 1, chronic_window_days: 1 },
      }),
    );
    expect(rows.at(-1)).toEqual(
      expect.objectContaining({
        date: "2026-09-01",
        coverage: { acute_window_days: 7, chronic_window_days: 28 },
      }),
    );
  });
});
