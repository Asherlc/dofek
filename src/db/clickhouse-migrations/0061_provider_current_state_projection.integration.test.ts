import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { METRIC_STREAM_PROVIDER_CURRENT_STATE_PROJECTION } from "../../metric-stream/clickhouse-table.ts";
import { createClickHouseClientFromEnv } from "../clickhouse.ts";
import { createMigration } from "./0061_provider_current_state_projection.ts";

const projectionPartSchema = z.array(
  z.object({
    missing_projection_parts: z.coerce.number().int().nonnegative(),
  }),
);
const countSchema = z.array(z.object({ count: z.coerce.number().int().nonnegative() }));

describe("0061_provider_current_state_projection", () => {
  const database = `provider_current_state_${randomUUID().replaceAll("-", "")}`;
  const table = `${database}.metric_stream`;
  const client = createClickHouseClientFromEnv();

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await client.close?.();
  });

  it("adds and materializes an exact latest-state aggregate projection", async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({
      query: `CREATE TABLE ${table} (
          user_id UUID,
          provider_id String,
          id UUID,
          is_deleted Int8,
          version Int64,
          ingested_at DateTime64(9, 'UTC')
        )
        ENGINE = ReplacingMergeTree(version)
        ORDER BY (user_id, id)
        SETTINGS deduplicate_merge_projection_mode = 'rebuild'`,
    });

    const userId = randomUUID();
    const resurrectedId = randomUUID();
    const liveId = randomUUID();
    for (const values of [
      "({userId:UUID}, 'test_provider', {resurrectedId:UUID}, 0, 1, now64(9) - INTERVAL 2 SECOND)",
      "({userId:UUID}, 'test_provider', {resurrectedId:UUID}, 1, 2, now64(9) - INTERVAL 1 SECOND)",
      `({userId:UUID}, 'test_provider', {resurrectedId:UUID}, 0, 3, now64(9)),
       ({userId:UUID}, 'test_provider', {liveId:UUID}, 0, 1, now64(9))`,
    ]) {
      await client.command({
        query: `INSERT INTO ${table} VALUES ${values}`,
        query_params: { liveId, resurrectedId, userId },
      });
    }

    for (const statement of createMigration().statements) {
      await client.command({ query: statement.replaceAll("ingest.metric_stream", table) });
    }

    const beforeMaterialization = await client.query({
      query: `SELECT countIf(NOT has(
          projections,
          {projectionName:String}
        )) AS missing_projection_parts
        FROM system.parts
        WHERE active
          AND database = {database:String}
          AND table = 'metric_stream'`,
      query_params: {
        database,
        projectionName: METRIC_STREAM_PROVIDER_CURRENT_STATE_PROJECTION,
      },
      format: "JSONEachRow",
    });
    const [projectionParts] = projectionPartSchema.parse(await beforeMaterialization.json());
    expect(projectionParts?.missing_projection_parts).toBeGreaterThan(0);

    await client.command({
      query: `ALTER TABLE ${table}
        MATERIALIZE PROJECTION ${METRIC_STREAM_PROVIDER_CURRENT_STATE_PROJECTION}`,
      clickhouse_settings: { mutations_sync: 2 },
    });

    const countResult = await client.query({
      query: `SELECT count() AS count
        FROM (
          SELECT
            user_id,
            provider_id,
            id,
            argMax(is_deleted, tuple(version, ingested_at)) AS is_deleted
          FROM ${table}
          WHERE user_id = {userId:UUID}
            AND provider_id = 'test_provider'
          GROUP BY user_id, provider_id, id
        )
        WHERE is_deleted = 0
        SETTINGS
          force_optimize_projection = 1,
          force_optimize_projection_name = '${METRIC_STREAM_PROVIDER_CURRENT_STATE_PROJECTION}'`,
      query_params: {
        userId,
      },
      format: "JSONEachRow",
    });
    expect(countSchema.parse(await countResult.json())).toEqual([{ count: 2 }]);
  });
});
