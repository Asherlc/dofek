import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildAccountErasureFenceTableSql } from "../metric-stream/clickhouse-table.ts";
import { runProcess } from "./activity-payload-dbt-microbatch-test-helpers.ts";
import { createClickHouseClientFromEnv } from "./clickhouse.ts";
import { buildActivitySummaryRowsTableSql } from "./clickhouse-activity-summary.ts";
import { cyclingPowerSchemaStatements } from "./cycling-power-schema.ts";

describe("cycling power projection publication", () => {
  const client = createClickHouseClientFromEnv();
  const database = `cycling_publication_${randomUUID().replaceAll("-", "")}`;
  const targetDatabase = `${database}_target`;

  beforeAll(async () => {
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({ query: `CREATE DATABASE ${targetDatabase}` });
    await client.command({
      query: buildAccountErasureFenceTableSql().replaceAll("ingest.", `${database}.`),
    });
    await client.command({
      query: buildActivitySummaryRowsTableSql().replaceAll("analytics.", `${database}.`),
    });
    for (const query of cyclingPowerSchemaStatements())
      await client.command({
        query: query.replaceAll("analytics.", `${database}.`).replaceAll("ingest.", `${database}.`),
      });
  });

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${targetDatabase} SYNC` });
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close?.();
  });

  async function insertSummary(userId: string, activityId: string, refreshVersion = 1) {
    await client.command({
      query: `INSERT INTO ${database}.activity_summary_rows
        (user_id,activity_id,started_at,ended_at,canonical_type,power_sample_count,refresh_version,is_deleted,refreshed_at)
        VALUES ('${userId}','${activityId}',now64(6) - INTERVAL 1 HOUR,now64(6) - INTERVAL 30 MINUTE,
          'cycling',60,${refreshVersion},0,now64(9))`,
    });
  }

  async function insertObservation(
    userId: string,
    activityId: string,
    sourceRefreshVersion: number,
    refreshVersion: number,
    isDeleted = 0,
  ) {
    await client.command({
      query: `INSERT INTO ${database}.cycling_power_observation_rows
        (user_id,activity_id,normalized_power,source_refresh_version,model_version,is_deleted,refresh_version,refreshed_at)
        VALUES ('${userId}','${activityId}',240,${sourceRefreshVersion},'np-v1',${isDeleted},${refreshVersion},now64(6))`,
    });
  }

  async function readServingRows(userId: string) {
    const result = await client.query({
      query: `SELECT toString(activity_id) AS activity_id, normalized_power, canonical_type
        FROM ${database}.cycling_activity_power_metrics WHERE user_id={userId:UUID}`,
      query_params: { userId },
      format: "JSONEachRow",
    });
    return z
      .array(
        z.object({
          activity_id: z.string(),
          normalized_power: z.coerce.number(),
          canonical_type: z.string(),
        }),
      )
      .parse(await result.json());
  }

  it("serves only fresh live observations for active summary rows", async () => {
    const userId = randomUUID();
    const activityId = randomUUID();
    await insertSummary(userId, activityId, 2);
    await insertObservation(userId, activityId, 1, 1);
    expect(await readServingRows(userId)).toEqual([]);

    await insertObservation(userId, activityId, 2, 2);
    expect(await readServingRows(userId)).toEqual([
      { activity_id: activityId, normalized_power: 240, canonical_type: "cycling" },
    ]);

    await insertObservation(userId, activityId, 2, 3, 1);
    expect(await readServingRows(userId)).toEqual([]);
  });

  it("hides published observations after the scoped account erasure fence is inserted", async () => {
    const userId = randomUUID();
    const activityId = randomUUID();
    await insertSummary(userId, activityId);
    await insertObservation(userId, activityId, 1, 1);
    expect(await readServingRows(userId)).toHaveLength(1);

    await client.command({
      query: `INSERT INTO ${database}.account_erasure_fence (user_hash)
        SELECT lower(hex(SHA256(toString({userId:UUID}))))`,
      query_params: { userId },
    });
    expect(await readServingRows(userId)).toEqual([]);
  });

  it("builds the dbt serving view from overridden analytics and ingest source schemas", async () => {
    const userId = randomUUID();
    const activityId = randomUUID();
    await insertSummary(userId, activityId);
    await insertObservation(userId, activityId, 1, 1);
    const artifacts = await mkdtemp(join(tmpdir(), "cycling-source-override-"));
    const connection = process.env.CLICKHOUSE_URL;
    if (!connection) throw new Error("CLICKHOUSE_URL is required");
    const url = new URL(connection);
    try {
      const result = await runProcess(
        "uv",
        [
          "run",
          "--project",
          "analytics",
          "dbt",
          "build",
          "--project-dir",
          "analytics",
          "--profiles-dir",
          "analytics",
          "--target",
          "dev",
          "--select",
          "cycling_activity_power_metrics",
          "--threads",
          "1",
          "--target-path",
          join(artifacts, "target"),
          "--log-path",
          join(artifacts, "logs"),
        ],
        {
          ...process.env,
          DBT_TARGET: "dev",
          DBT_CLICKHOUSE_SCHEMA: targetDatabase,
          DBT_ANALYTICS_SOURCE_SCHEMA: database,
          DBT_INGEST_SOURCE_SCHEMA: database,
          DBT_CLICKHOUSE_HOST: url.hostname,
          DBT_CLICKHOUSE_PORT: url.port,
          DBT_CLICKHOUSE_USER: decodeURIComponent(url.username) || "default",
          DBT_CLICKHOUSE_PASSWORD: decodeURIComponent(url.password),
          UV_PROJECT_ENVIRONMENT: "../.venv-analytics",
        },
      );
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      expect(await readServingRows(userId)).toHaveLength(1);
      const targetRows = await client.query({
        query: `SELECT toString(activity_id) AS activity_id, normalized_power, canonical_type
          FROM ${targetDatabase}.cycling_activity_power_metrics WHERE user_id={userId:UUID}`,
        query_params: { userId },
        format: "JSONEachRow",
      });
      expect(await targetRows.json()).toEqual([
        { activity_id: activityId, normalized_power: 240, canonical_type: "cycling" },
      ]);
    } finally {
      await rm(artifacts, { recursive: true, force: true });
    }
  });
});
