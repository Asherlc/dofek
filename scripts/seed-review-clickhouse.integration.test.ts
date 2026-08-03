import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../src/db/clickhouse.ts";
import { buildPostgresFitnessRawTableStatements } from "../src/db/clickhouse-raw-tables.ts";
import { setupTestDatabase, type TestContext } from "../src/db/test-helpers.ts";
import { buildIngestMetricStreamCreateTableSql } from "../src/metric-stream/clickhouse-table.ts";
import { buildReviewClickHouseCopyStatements } from "./seed-review-clickhouse.ts";

const sentinelId = "19870000-0000-4000-8000-000000000001";
const sentinelUserId = "19870000-0000-4000-8000-000000000002";
const sentinelRowsSchema = z.array(
  z.object({
    channel: z.string(),
    id: z.string().uuid(),
    scalar: z.coerce.number(),
  }),
);
const bodyWeightCountSchema = z.array(z.object({ count: z.coerce.number() }));
const reviewRawTableNames = [
  "activity",
  "device_priority",
  "provider",
  "provider_connection",
  "provider_priority",
  "sensor_device_priority",
  "sensor_provider_priority",
  "user_profile",
] as const;

describe("review ClickHouse seed maintenance", () => {
  const suffix = randomBytes(6).toString("hex");
  const ingestDatabase = `review_seed_ingest_test_${suffix}`;
  const postgresFitnessDatabase = `review_seed_postgres_test_${suffix}`;
  let clickHouseClient: ClickHouseClient | undefined;
  let testContext: TestContext | undefined;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    clickHouseClient = createClickHouseClientFromEnv();
    await clickHouseClient.command({ query: `CREATE DATABASE ${ingestDatabase}` });
    await clickHouseClient.command({ query: `CREATE DATABASE ${postgresFitnessDatabase}` });

    await clickHouseClient.command({
      query: buildIngestMetricStreamCreateTableSql().replaceAll(
        "ingest.metric_stream",
        `${ingestDatabase}.metric_stream`,
      ),
    });

    const rawTableStatements = buildPostgresFitnessRawTableStatements().filter((statement) =>
      reviewRawTableNames.some((tableName) =>
        statement.startsWith(`CREATE TABLE IF NOT EXISTS postgres_fitness.${tableName} (`),
      ),
    );
    if (rawTableStatements.length !== reviewRawTableNames.length) {
      throw new Error("Could not build every review-seed raw ClickHouse table");
    }
    for (const statement of rawTableStatements) {
      await clickHouseClient.command({
        query: statement.replaceAll("postgres_fitness.", `${postgresFitnessDatabase}.`),
      });
    }
  }, 120_000);

  afterAll(async () => {
    await testContext?.cleanup();
    if (clickHouseClient) {
      await clickHouseClient.command({
        query: `DROP DATABASE IF EXISTS ${ingestDatabase} SYNC`,
      });
      await clickHouseClient.command({
        query: `DROP DATABASE IF EXISTS ${postgresFitnessDatabase} SYNC`,
      });
      await clickHouseClient.close?.();
    }
  });

  it("preserves canonical metric-stream rows while refreshing relational review data", async () => {
    const activeClickHouseClient = requireClickHouseClient(clickHouseClient);
    const activeTestContext = requireTestContext(testContext);
    await activeClickHouseClient.command({
      query: `INSERT INTO ${ingestDatabase}.metric_stream (
        id,
        activity_id,
        user_id,
        recorded_at,
        channel,
        provider_id,
        external_id,
        device_id,
        source_type,
        scalar,
        vector,
        point,
        metadata,
        ingested_at,
        is_deleted,
        version,
        generation
      ) VALUES (
        {id:UUID},
        NULL,
        {user_id:UUID},
        toDateTime64('2026-07-26 12:00:00', 6, 'UTC'),
        'heart_rate',
        'integration-test',
        'review-seed-sentinel',
        NULL,
        'integration-test',
        123,
        [],
        '{"type":"Point","coordinates":[-122.4,37.8]}',
        '{}',
        now64(9),
        0,
        1,
        0
      )`,
      query_params: {
        id: sentinelId,
        user_id: sentinelUserId,
      },
    });

    let maintenanceFailure: unknown;
    try {
      for (let run = 0; run < 2; run++) {
        for (const statement of buildReviewClickHouseCopyStatements(
          activeTestContext.connectionString,
        )) {
          await activeClickHouseClient.command({
            query: rewriteReviewDatabases(statement, ingestDatabase, postgresFitnessDatabase),
          });
        }
      }
    } catch (error) {
      maintenanceFailure = error;
    }

    const result = await activeClickHouseClient.query({
      query: `SELECT id, channel, scalar
        FROM ${ingestDatabase}.metric_stream FINAL
        WHERE id = {id:UUID}`,
      query_params: { id: sentinelId },
      format: "JSONEachRow",
    });
    expect(sentinelRowsSchema.parse(await result.json())).toEqual([
      {
        channel: "heart_rate",
        id: sentinelId,
        scalar: 123,
      },
    ]);

    const bodyWeightResult = await activeClickHouseClient.query({
      query: `SELECT count() AS count
        FROM ${ingestDatabase}.metric_stream FINAL
        WHERE user_id = {user_id:UUID}
          AND channel = 'body_weight'
          AND provider_id = 'manual_review'
          AND startsWith(ifNull(external_id, ''), 'review-seed-body-weight-')
          AND is_deleted = 0`,
      query_params: { user_id: "00000000-0000-4000-8000-000000000001" },
      format: "JSONEachRow",
    });
    expect(bodyWeightCountSchema.parse(await bodyWeightResult.json())).toEqual([{ count: 90 }]);

    if (maintenanceFailure) {
      throw maintenanceFailure;
    }
  });
});

function rewriteReviewDatabases(
  statement: string,
  ingestDatabase: string,
  postgresFitnessDatabase: string,
): string {
  return statement
    .replaceAll("ingest.", `${ingestDatabase}.`)
    .replaceAll("postgres_fitness.", `${postgresFitnessDatabase}.`);
}

function requireClickHouseClient(clickHouseClient: ClickHouseClient | undefined): ClickHouseClient {
  if (!clickHouseClient) {
    throw new Error("ClickHouse client was not initialized");
  }
  return clickHouseClient;
}

function requireTestContext(testContext: TestContext | undefined): TestContext {
  if (!testContext) {
    throw new Error("Postgres test context was not initialized");
  }
  return testContext;
}
