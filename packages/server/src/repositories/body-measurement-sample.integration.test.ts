import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  backfillMissingBodyMeasurementSamples,
  countMissingBodyMeasurementSamples,
} from "../../../../src/db/body-measurement-sample.ts";
import { createMigration } from "../../../../src/db/clickhouse-migrations/0050_repair_body_measurement_sample_ingest.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import {
  createClickHouseTestActivitySensorStore,
  getClickHouseTestClient,
} from "../routers/clickhouse-integration-test-helpers.ts";

const countRowsSchema = z.array(z.object({ count: z.coerce.number().int().nonnegative() }));
const testUserId = "10000000-0000-4000-8000-000000000001";
const missedMeasurementId = "10000000-0000-4000-8000-000000000002";
const liveMeasurementId = "10000000-0000-4000-8000-000000000003";
const backfillRange = {
  start: new Date("2026-06-21T00:00:00.000Z"),
  end: new Date("2026-07-21T00:00:00.000Z"),
};

describe("body measurement sample projection repair", () => {
  let testContext: TestContext;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    await createClickHouseTestActivitySensorStore(testContext);
  });

  afterAll(async () => {
    await testContext?.cleanup();
  });

  it("reattaches live ingestion and backfills only the missed body rows", async () => {
    const client = getClickHouseTestClient(testContext);
    await client.command({ query: "DROP VIEW analytics.body_measurement_sample_ingest" });
    await insertWeight(client, missedMeasurementId, "2026-06-22 12:00:00");

    expect(await projectedRowCount(client)).toBe(0);

    for (const statement of createMigration().statements) {
      await client.command({ query: statement });
    }
    await insertWeight(client, liveMeasurementId, "2026-07-20 12:00:00");

    expect(await projectedRowCount(client)).toBe(1);
    expect(await countMissingBodyMeasurementSamples(client, backfillRange)).toBe(1);
    expect(await backfillMissingBodyMeasurementSamples(client, backfillRange)).toBe(1);
    expect(await projectedRowCount(client)).toBe(2);
    expect(await countMissingBodyMeasurementSamples(client, backfillRange)).toBe(0);
  });
});

async function insertWeight(
  client: ReturnType<typeof getClickHouseTestClient>,
  id: string,
  recordedAt: string,
): Promise<void> {
  await client.command({
    query: `INSERT INTO ingest.metric_stream (
      id, activity_id, user_id, recorded_at, channel, provider_id, external_id,
      device_id, source_type, scalar, vector, point, metadata, ingested_at,
      is_deleted, version, generation
    ) VALUES (
      {id:UUID}, NULL, {userId:UUID}, {recordedAt:DateTime64(6)},
      'body_weight', 'withings', {id:String}, NULL, 'api', 80, [], '', '',
      now64(9), 0, 1, 0
    )`,
    query_params: { id, recordedAt, userId: testUserId },
  });
}

async function projectedRowCount(
  client: ReturnType<typeof getClickHouseTestClient>,
): Promise<number> {
  const result = await client.query({
    query:
      "SELECT count() AS count FROM analytics.body_measurement_sample FINAL WHERE user_id = {userId:UUID}",
    format: "JSONEachRow",
    query_params: { userId: testUserId },
  });
  const rows = countRowsSchema.parse(await result.json());
  return rows[0]?.count ?? 0;
}
