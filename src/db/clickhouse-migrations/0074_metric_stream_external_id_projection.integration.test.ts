import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { METRIC_STREAM_PROVIDER_EXTERNAL_ID_PROJECTION } from "../../metric-stream/clickhouse-table.ts";
import { createClickHouseClientFromEnv } from "../clickhouse.ts";
import { createMigration } from "./0074_metric_stream_external_id_projection.ts";

const projectionPartSchema = z.array(
  z.object({
    missing_projection_parts: z.coerce.number().int().nonnegative(),
  }),
);
const idRowsSchema = z.array(z.object({ id: z.uuid() }));

describe("0074_metric_stream_external_id_projection", () => {
  const database = `metric_stream_external_id_${randomUUID().replaceAll("-", "")}`;
  const table = `${database}.metric_stream`;
  const client = createClickHouseClientFromEnv();

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await client.close?.();
  });

  it("adds and materializes a covering external-ID lookup projection", async () => {
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({
      query: `CREATE TABLE ${table} (
          id UUID,
          activity_id Nullable(UUID),
          user_id UUID,
          recorded_at DateTime64(6, 'UTC'),
          channel String,
          provider_id String,
          external_id Nullable(String),
          device_id Nullable(String),
          source_type Nullable(String),
          scalar Nullable(Float32),
          vector Array(Float32),
          point String,
          metadata String,
          ingested_at DateTime64(9, 'UTC'),
          is_deleted Int8,
          version Int64,
          generation UInt64
        )
        ENGINE = ReplacingMergeTree(version)
        ORDER BY (user_id, activity_id, channel, recorded_at, id)
        SETTINGS allow_nullable_key = 1, deduplicate_merge_projection_mode = 'rebuild'`,
    });

    const userId = randomUUID();
    const matchingId = randomUUID();
    const unrelatedId = randomUUID();
    await client.command({
      query: `INSERT INTO ${table} (
          id, activity_id, user_id, recorded_at, channel, provider_id, external_id,
          device_id, source_type, scalar, vector, point, metadata, ingested_at,
          is_deleted, version, generation
        ) VALUES
          ({matchingId:UUID}, NULL, {userId:UUID}, now64(6), 'heart_rate',
            'apple_health', 'matching-external-id', NULL, 'file', 72, [], '', '', now64(9), 0, 1, 0),
          ({unrelatedId:UUID}, NULL, {userId:UUID}, now64(6), 'heart_rate',
            'apple_health', 'unrelated-external-id', NULL, 'file', 73, [], '', '', now64(9), 0, 1, 0)`,
      query_params: { matchingId, unrelatedId, userId },
    });

    for (const statement of createMigration().statements) {
      await client.command({ query: statement.replaceAll("ingest.metric_stream", table) });
    }
    const beforeMaterialization = await client.query({
      query: `SELECT countIf(NOT has(projections, {projectionName:String})) AS missing_projection_parts
        FROM system.parts
        WHERE active
          AND database = {database:String}
          AND table = 'metric_stream'`,
      query_params: {
        database,
        projectionName: METRIC_STREAM_PROVIDER_EXTERNAL_ID_PROJECTION,
      },
      format: "JSONEachRow",
    });
    const [before] = projectionPartSchema.parse(await beforeMaterialization.json());
    expect(before?.missing_projection_parts).toBeGreaterThan(0);

    await client.command({
      query: `ALTER TABLE ${table}
        MATERIALIZE PROJECTION ${METRIC_STREAM_PROVIDER_EXTERNAL_ID_PROJECTION}`,
      clickhouse_settings: { mutations_sync: 2 },
    });

    const result = await client.query({
      query: `SELECT toString(id) AS id
        FROM ${table}
        WHERE user_id = {userId:UUID}
          AND provider_id = 'apple_health'
          AND external_id = 'matching-external-id'
        SETTINGS
          force_optimize_projection = 1,
          force_optimize_projection_name = '${METRIC_STREAM_PROVIDER_EXTERNAL_ID_PROJECTION}'`,
      query_params: { userId },
      format: "JSONEachRow",
    });
    expect(idRowsSchema.parse(await result.json())).toEqual([{ id: matchingId }]);
  });
});
