import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { readModelSql } from "../../../../analytics/models/read_models/read-model-sql-test-helpers.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import {
  createClickHouseTestActivitySensorStore,
  getClickHouseTestClient,
} from "../routers/clickhouse-integration-test-helpers.ts";

const rowCountSchema = z.array(
  z.object({
    count: z.coerce.number().int(),
    user_count: z.coerce.number().int(),
  }),
);
const lifecycleSchema = z.array(
  z.object({
    id: z.string(),
    is_deleted: z.coerce.number().int(),
  }),
);

function renderBodyMeasurementSql(isIncremental: boolean, targetTable?: string): string {
  const renderedSql = readModelSql("body_measurement.sql")
    .replace(/^\{\{ config\([\s\S]*?\n\) \}\}\s*/, "")
    .replace(
      /\{\{\s*source\('analytics',\s*'body_measurement_sample'\)\s*\}\}/g,
      "analytics.body_measurement_sample",
    )
    .replace(/\{\{\s*source\('postgres_fitness',\s*'([^']+)'\)\s*\}\}/g, "postgres_fitness.$1")
    .replace(
      /\{%\s*if is_incremental\(\)\s*%\}([\s\S]*?)(?:\{%\s*else\s*%\}([\s\S]*?))?\{%\s*endif\s*%\}/g,
      (_, incrementalSql: string, nonIncrementalSql: string | undefined) =>
        isIncremental ? incrementalSql : (nonIncrementalSql ?? ""),
    );

  if (!isIncremental) return renderedSql;
  if (!targetTable) throw new Error("Incremental body measurement SQL requires a target table");
  return renderedSql.replace(/\{\{\s*this\s*\}\}/g, targetTable);
}

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

    const result = await client.query({
      query: `SELECT
        count() AS count,
        uniqExact(user_id) AS user_count
      FROM (${renderBodyMeasurementSql(false)})
      WHERE user_id IN ({userId:UUID}, {secondUserId:UUID})`,
      query_params: { secondUserId, userId },
      format: "JSONEachRow",
    });

    expect(rowCountSchema.parse(await result.json())).toEqual([{ count: 3, user_count: 2 }]);
  });

  it("tombstones a previously materialized measurement when its source is deleted", async () => {
    const client = getClickHouseTestClient(testContext);
    const userId = randomUUID();
    const measurementId = randomUUID();
    const targetTable = `analytics.test_body_measurement_${randomUUID().replaceAll("-", "")}`;

    await client.command({
      query: `CREATE TABLE ${targetTable} (
        id UUID,
        provider_id String,
        user_id UUID,
        external_id String,
        recorded_at DateTime64(6, 'UTC'),
        created_at DateTime64(9, 'UTC'),
        weight_kg Nullable(Float32),
        body_fat_pct Nullable(Float32),
        muscle_mass_kg Nullable(Float32),
        bone_mass_kg Nullable(Float32),
        water_pct Nullable(Float32),
        bmi Nullable(Float32),
        height_cm Nullable(Float32),
        waist_circumference_cm Nullable(Float32),
        systolic_bp Nullable(Float32),
        diastolic_bp Nullable(Float32),
        heart_pulse Nullable(Float32),
        temperature_c Nullable(Float32),
        source_name Nullable(String),
        source_providers Array(String),
        source_refreshed_at DateTime64(9, 'UTC'),
        is_deleted UInt8,
        refresh_version UInt64,
        refreshed_at DateTime64(9, 'UTC')
      ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, id)`,
    });

    try {
      await client.command({
        query: `INSERT INTO ${targetTable} VALUES (
          {measurementId:UUID}, 'test_provider', {userId:UUID}, 'test_provider:deleted',
          '2026-07-20 00:00:00', '2026-07-20 00:00:00',
          80, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
          NULL, ['test_provider'], '2026-07-20 00:00:00', 0, 1, '2026-07-20 00:00:00'
        )`,
        query_params: { measurementId, userId },
      });
      await client.command({
        query: `INSERT INTO analytics.body_measurement_sample (
          id, provider_id, user_id, recorded_at, channel, external_id, device_id,
          source_type, scalar, _peerdb_synced_at, _peerdb_is_deleted, _peerdb_version
        ) VALUES (
          {measurementId:UUID}, 'test_provider', {userId:UUID}, '2026-07-20 00:00:00',
          'body_weight', 'deleted', NULL, 'api', 80,
          '2026-07-21 00:00:00', 1, 2
        )`,
        query_params: { measurementId, userId },
      });

      const result = await client.query({
        query: `SELECT toString(result.id) AS id, result.is_deleted
          FROM (${renderBodyMeasurementSql(true, targetTable)}) AS result
          WHERE result.id = {measurementId:UUID}
          SETTINGS join_use_nulls = 1`,
        query_params: { measurementId },
        format: "JSONEachRow",
      });

      expect(lifecycleSchema.parse(await result.json())).toEqual([
        { id: measurementId, is_deleted: 1 },
      ]);
    } finally {
      await client.command({ query: `DROP TABLE IF EXISTS ${targetTable}` });
    }
  });
});
