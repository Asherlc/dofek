import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import {
  createClickHouseTestActivitySensorStore,
  executeClickHouseTestCommand,
  getClickHouseTestClient,
} from "../routers/clickhouse-integration-test-helpers.ts";
import { type BodyClickHouseStore, fetchBodyDecisionMeasurements } from "./body-clickhouse.ts";
import { BodyRepository } from "./body-repository.ts";

describe("BodyRepository exact local-date range", () => {
  let store: BodyClickHouseStore;
  let testContext: TestContext;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    store = await createClickHouseTestActivitySensorStore(testContext);
  }, 120_000);

  afterAll(async () => {
    await testContext?.cleanup();
  });

  it("filters native timestamps before serializing rows", async () => {
    const client = getClickHouseTestClient(testContext);
    const userId = randomUUID();
    const priorLocalDateId = randomUUID();
    const matchingLocalDateId = randomUUID();

    for (const [index, row] of [
      {
        id: priorLocalDateId,
        recordedAt: "2026-05-29 06:55:00",
      },
      {
        id: matchingLocalDateId,
        recordedAt: "2026-05-29 07:05:00",
      },
    ].entries()) {
      await client.command({
        query: `INSERT INTO analytics.body_measurement_sample (
          id, provider_id, user_id, recorded_at, channel, external_id, device_id,
          source_type, scalar, _peerdb_synced_at, _peerdb_is_deleted, _peerdb_version
        ) VALUES (
          {id:UUID}, 'withings', {userId:UUID}, {recordedAt:DateTime64(6, 'UTC')},
          'body_weight', {externalId:String}, 'Body Scale', 'api', 80,
          now64(9), 0, {version:Int64}
        )`,
        query_params: {
          externalId: `body-range-${index}`,
          id: row.id,
          recordedAt: row.recordedAt,
          userId,
          version: index + 1,
        },
      });
    }

    await executeClickHouseTestCommand(
      testContext,
      "REBUILD TEST ANALYTICS TABLE analytics.v_body_measurement",
    );

    const repository = new BodyRepository(store, userId, "America/Los_Angeles");
    const rows = await repository.listRange("2026-05-29", "2026-05-29");

    expect(rows.map((row) => row.id)).toEqual([matchingLocalDateId]);
  });

  it("returns provider provenance and configured local clock time", async () => {
    const client = getClickHouseTestClient(testContext);
    const userId = randomUUID();
    const measurementId = randomUUID();

    await client.command({
      query: `INSERT INTO analytics.body_measurement_sample (
        id, provider_id, user_id, recorded_at, channel, external_id, device_id,
        source_type, scalar, _peerdb_synced_at, _peerdb_is_deleted, _peerdb_version
      ) VALUES (
        {id:UUID}, 'withings', {userId:UUID}, '2026-05-29 07:05:00',
        'body_weight', 'body-decision-context', 'Body Scale', 'api', 80,
        now64(9), 0, 1
      )`,
      query_params: { id: measurementId, userId },
    });

    await executeClickHouseTestCommand(
      testContext,
      "REBUILD TEST ANALYTICS TABLE analytics.v_body_measurement",
    );

    const rows = await fetchBodyDecisionMeasurements(
      store,
      userId,
      "America/Los_Angeles",
      "2026-05-29",
    );

    expect(rows).toEqual([
      expect.objectContaining({
        date: "2026-05-29",
        recorded_at_local: "2026-05-29 00:05:00",
        weight_kg: 80,
        provider_id: "withings",
        source_name: "Body Scale",
      }),
    ]);
  });
});
