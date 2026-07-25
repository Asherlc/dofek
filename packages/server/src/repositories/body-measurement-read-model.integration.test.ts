import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import {
  createClickHouseTestActivitySensorStore,
  executeClickHouseTestCommand,
  getClickHouseTestClient,
} from "../routers/clickhouse-integration-test-helpers.ts";

const rowCountSchema = z.array(
  z.object({
    count: z.coerce.number().int(),
    user_count: z.coerce.number().int(),
  }),
);

describe("body measurement read model", () => {
  let testContext: TestContext;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    await createClickHouseTestActivitySensorStore(testContext);
  });

  afterAll(async () => {
    await testContext?.cleanup();
  });

  it("preserves transitive five-minute grouping without recursive graph expansion", async () => {
    const client = getClickHouseTestClient(testContext);
    const userId = randomUUID();
    const secondUserId = randomUUID();
    const rows = [
      {
        id: randomUUID(),
        providerId: "apple_health",
        recordedAt: "2026-07-20 00:00:00",
        userId,
      },
      {
        id: randomUUID(),
        providerId: "withings",
        recordedAt: "2026-07-20 00:04:00",
        userId,
      },
      {
        id: randomUUID(),
        providerId: "garmin",
        recordedAt: "2026-07-20 00:08:00",
        userId,
      },
      {
        id: randomUUID(),
        providerId: "polar",
        recordedAt: "2026-07-20 00:13:00",
        userId,
      },
      {
        id: randomUUID(),
        providerId: "apple_health",
        recordedAt: "2026-07-20 00:00:00",
        userId: secondUserId,
      },
    ];

    for (const [index, row] of rows.entries()) {
      await client.command({
        query: `INSERT INTO analytics.body_measurement_sample (
          id, provider_id, user_id, recorded_at, channel, external_id, device_id,
          source_type, scalar, _peerdb_synced_at, _peerdb_is_deleted, _peerdb_version
        ) VALUES (
          {id:UUID}, {providerId:String}, {userId:UUID}, {recordedAt:DateTime64(6, 'UTC')},
          'body_weight', {externalId:String}, NULL, 'api', 80,
          now64(9), 0, {version:Int64}
        )`,
        query_params: {
          externalId: `measurement-${index}`,
          id: row.id,
          providerId: row.providerId,
          recordedAt: row.recordedAt,
          userId: row.userId,
          version: index + 1,
        },
      });
    }

    await executeClickHouseTestCommand(
      testContext,
      "REBUILD TEST ANALYTICS TABLE analytics.v_body_measurement",
    );

    const result = await client.query({
      query: `SELECT
        count() AS count,
        uniqExact(user_id) AS user_count
      FROM analytics.v_body_measurement
      WHERE user_id IN ({userId:UUID}, {secondUserId:UUID})`,
      query_params: { secondUserId, userId },
      format: "JSONEachRow",
    });

    expect(rowCountSchema.parse(await result.json())).toEqual([{ count: 3, user_count: 2 }]);
  });
});
