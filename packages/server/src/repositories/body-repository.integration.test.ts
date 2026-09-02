import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import {
  createClickHouseTestActivitySensorStore,
  executeClickHouseTestCommand,
  getClickHouseTestClient,
  syncClickHouseTestActivitySensorStore,
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

  it("keeps the latest same-provider measurement for a local date", async () => {
    const client = getClickHouseTestClient(testContext);
    const userId = randomUUID();
    const earlierMeasurementId = randomUUID();
    const latestMeasurementId = randomUUID();

    for (const [index, row] of [
      { id: earlierMeasurementId, recordedAt: "2026-05-14 14:00:00", weightKg: 89.7 },
      { id: latestMeasurementId, recordedAt: "2026-05-14 15:00:00", weightKg: 90.0 },
    ].entries()) {
      await client.command({
        query: `INSERT INTO analytics.body_measurement_sample (
          id, provider_id, user_id, recorded_at, channel, external_id, device_id,
          source_type, scalar, _peerdb_synced_at, _peerdb_is_deleted, _peerdb_version
        ) VALUES (
          {id:UUID}, 'apple_health', {userId:UUID}, {recordedAt:DateTime64(6, 'UTC')},
          'body_weight', {externalId:String}, 'Apple Health', 'healthkit', {weightKg:Float64},
          now64(9), 0, {version:Int64}
        )`,
        query_params: {
          externalId: `duplicate-body-measurement-${index}`,
          id: row.id,
          recordedAt: row.recordedAt,
          userId,
          version: index + 1,
          weightKg: row.weightKg,
        },
      });
    }

    await executeClickHouseTestCommand(
      testContext,
      "REBUILD TEST ANALYTICS TABLE analytics.v_body_measurement",
    );

    const repository = new BodyRepository(store, userId, "America/Los_Angeles");
    const rows = await repository.listRange("2026-05-14", "2026-05-14");

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(latestMeasurementId);
    expect(rows[0]?.weightKg).toBe(90);
  });

  it("reconciles same-day providers using body priority and retains source values", async () => {
    const client = getClickHouseTestClient(testContext);
    const userId = randomUUID();
    const withingsProvider = `withings-reconcile-${userId}`;
    const appleProvider = `apple-reconcile-${userId}`;

    await testContext.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name)
          VALUES (${userId}::uuid, 'Body Reconciliation Fixture')
          ON CONFLICT DO NOTHING`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES
            (${withingsProvider}, 'Withings Reconciliation Fixture', ${userId}::uuid),
            (${appleProvider}, 'Apple Reconciliation Fixture', ${userId}::uuid)`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.provider_priority (provider_id, priority, body_priority)
          VALUES (${withingsProvider}, 10, 10), (${appleProvider}, 20, 20)`,
    );
    await syncClickHouseTestActivitySensorStore(testContext);

    for (const [index, row] of [
      { providerId: withingsProvider, recordedAt: "2026-05-14 15:00:00", weightKg: 90 },
      { providerId: appleProvider, recordedAt: "2026-05-14 16:00:00", weightKg: 89.7 },
    ].entries()) {
      await client.command({
        query: `INSERT INTO analytics.body_measurement_sample (
          id, provider_id, user_id, recorded_at, channel, external_id, device_id,
          source_type, scalar, _peerdb_synced_at, _peerdb_is_deleted, _peerdb_version
        ) VALUES (
          {id:UUID}, {providerId:String}, {userId:UUID}, {recordedAt:DateTime64(6, 'UTC')},
          'body_weight', {externalId:String}, {providerId:String}, 'integration_test',
          {weightKg:Float64}, now64(9), 0, {version:Int64}
        )`,
        query_params: {
          externalId: `body-reconciliation-${index}`,
          id: randomUUID(),
          providerId: row.providerId,
          recordedAt: row.recordedAt,
          userId,
          version: index + 1,
          weightKg: row.weightKg,
        },
      });
    }

    await executeClickHouseTestCommand(
      testContext,
      "REBUILD TEST ANALYTICS TABLE analytics.v_body_measurement",
    );

    const repository = new BodyRepository(store, userId, "America/Los_Angeles");
    const rows = await repository.listReconciledRange("2026-05-14", "2026-05-14");

    expect(rows).toEqual([
      expect.objectContaining({
        date: "2026-05-14",
        weightKg: 90,
        sourceProviderByMetric: expect.objectContaining({ weightKg: withingsProvider }),
        sources: [
          expect.objectContaining({ sourceProvider: withingsProvider, weightKg: 90 }),
          expect.objectContaining({ sourceProvider: appleProvider, weightKg: 89.7 }),
        ],
        coverage: { sourceCount: 2 },
      }),
    ]);
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
