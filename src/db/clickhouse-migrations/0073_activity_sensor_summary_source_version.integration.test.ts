import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createClickHouseClientFromEnv } from "../clickhouse.ts";
import { createMigration } from "./0073_activity_sensor_summary_source_version.ts";

const versionSchema = z.array(
  z.object({
    activity_id: z.string().uuid(),
    source_refresh_version: z.coerce.number().int().nonnegative(),
  }),
);

describe("0073_activity_sensor_summary_source_version", () => {
  const database = `activity_source_version_${randomUUID().replaceAll("-", "")}`;
  const client = createClickHouseClientFromEnv();

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await client.close?.();
  });

  it("serves exact source versions after incremental lightweight deletes", async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({
      query: `CREATE TABLE ${database}.activity_sensor_sample (
        activity_id UUID,
        user_id UUID,
        refresh_version UInt64
      ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, activity_id)`,
    });
    await client.command({
      query: `CREATE TABLE ${database}.activity_sensor_summary_rows (
        activity_id UUID,
        user_id UUID,
        climbing_seconds Nullable(Float64)
      ) ENGINE = MergeTree
      ORDER BY (user_id, activity_id)`,
    });

    const userId = randomUUID();
    const firstActivityId = randomUUID();
    const secondActivityId = randomUUID();
    await client.command({
      query: `INSERT INTO ${database}.activity_sensor_sample VALUES
        ({firstActivityId:UUID}, {userId:UUID}, 10)`,
      query_params: { firstActivityId, userId },
    });

    for (const statement of createMigration().statements) {
      await client.command({ query: statement.replaceAll("analytics.", `${database}.`) });
    }

    await client.command({
      query: `INSERT INTO ${database}.activity_sensor_sample VALUES
        ({firstActivityId:UUID}, {userId:UUID}, 30),
        ({secondActivityId:UUID}, {userId:UUID}, 20)`,
      query_params: { firstActivityId, secondActivityId, userId },
    });
    await client.command({
      query: `ALTER TABLE ${database}.activity_sensor_sample
        MATERIALIZE PROJECTION by_activity_source_refresh_version`,
      clickhouse_settings: { mutations_sync: 2 },
    });

    const result = await client.query({
      query: `SELECT
        activity_id,
        max(refresh_version) AS source_refresh_version
      FROM ${database}.activity_sensor_sample
      GROUP BY activity_id, user_id
      ORDER BY activity_id
      SETTINGS
        force_optimize_projection = 1,
        force_optimize_projection_name = 'by_activity_source_refresh_version'`,
      format: "JSONEachRow",
    });

    const versions = versionSchema.parse(await result.json());
    expect(versions).toHaveLength(2);
    expect(versions).toEqual(
      expect.arrayContaining([
        { activity_id: firstActivityId, source_refresh_version: 30 },
        { activity_id: secondActivityId, source_refresh_version: 20 },
      ]),
    );

    await client.command({
      query: `DELETE FROM ${database}.activity_sensor_sample
        WHERE activity_id = {firstActivityId:UUID}`,
      query_params: { firstActivityId },
      clickhouse_settings: { lightweight_deletes_sync: 2 },
    });

    const afterDelete = await client.query({
      query: `SELECT
        activity_id,
        max(refresh_version) AS source_refresh_version
      FROM ${database}.activity_sensor_sample
      GROUP BY activity_id, user_id
      SETTINGS
        force_optimize_projection = 1,
        force_optimize_projection_name = 'by_activity_source_refresh_version'`,
      format: "JSONEachRow",
    });
    expect(versionSchema.parse(await afterDelete.json())).toEqual([
      { activity_id: secondActivityId, source_refresh_version: 20 },
    ]);
  });
});
