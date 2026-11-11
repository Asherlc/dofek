import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { runProcess } from "./activity-payload-dbt-microbatch-test-helpers.ts";
import { createClickHouseClientFromEnv } from "./clickhouse.ts";
import { cyclingPowerSchemaStatements } from "./cycling-power-schema.ts";

describe("cycling power projection publication", () => {
  const client = createClickHouseClientFromEnv();
  const database = `cycling_publication_${randomUUID().replaceAll("-", "")}`;
  const targetDatabase = `${database}_target`;
  const userId = randomUUID();
  const activityId = randomUUID();
  beforeAll(async () => {
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({ query: `CREATE DATABASE ${targetDatabase}` });
    for (const query of cyclingPowerSchemaStatements())
      await client.command({ query: query.replaceAll("analytics.", `${database}.`) });
  });
  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${targetDatabase} SYNC` });
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close?.();
  });
  const count = async (view: string) => {
    const result = await client.query({
      query: `SELECT count() AS count FROM ${database}.${view} WHERE user_id={userId:UUID}`,
      query_params: { userId },
      format: "JSONEachRow",
    });
    return z.array(z.object({ count: z.coerce.number() })).parse(await result.json())[0]?.count;
  };
  it("withholds mixed revisions until the complete history is published", async () => {
    await client.command({
      query: `INSERT INTO ${database}.cycling_power_observation_rows VALUES ('${userId}','${activityId}',240,1,'np-v1',0,100,now64(6))`,
    });
    await client.command({
      query: `INSERT INTO ${database}.cycling_power_history_rows VALUES ('${userId}',1,today(),'bank-v1',[(1000.0,'${activityId}',240.0,1.0,100.0,'${activityId}',1000.0,1200.0,255.0)],200,now64(6))`,
    });
    expect(Number(await count("cycling_activity_power_metrics"))).toBe(1);
    await client.command({
      query: `INSERT INTO ${database}.cycling_power_observation_rows VALUES ('${userId}','${activityId}',200,2,'np-v1',0,300,now64(6))`,
    });
    expect(Number(await count("cycling_activity_power_metrics"))).toBe(0);
    expect(Number(await count("cycling_threshold_history"))).toBe(0);
    await client.command({
      query: `INSERT INTO ${database}.cycling_power_history_rows VALUES ('${userId}',2,today(),'bank-v1',[(1000.0,'${activityId}',250.0,0.8,64.0,'${activityId}',1000.0,1200.0,266.0)],400,toDateTime64('2026-11-02 15:00:00', 6, 'UTC'))`,
    });
    const result = await client.query({
      query: `SELECT normalized_power,eftp,power_tss,model_version,
        formatDateTime(refreshed_at, '%Y-%m-%dT%H:%i:%SZ', 'UTC') AS refreshed_at
        FROM ${database}.cycling_activity_power_metrics`,
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([
      {
        normalized_power: 200,
        eftp: 250,
        power_tss: 64,
        model_version: "bank-v1",
        refreshed_at: "2026-11-02T15:00:00Z",
      },
    ]);
  });

  it("publishes nullable calendar identities and missing evidence without empty-string sentinels", async () => {
    const missingUserId = randomUUID();
    const missingActivityId = randomUUID();
    await client.command({
      query: `INSERT INTO ${database}.cycling_power_history_rows VALUES
      ('${missingUserId}',1,today(),'bank-v1',[
        (1000.0,NULL,NULL,NULL,NULL,NULL,0.0,0.0,0.0),
        (2000.0,'${missingActivityId}',NULL,NULL,NULL,NULL,0.0,0.0,0.0)
      ],100,now64(6))`,
    });
    const stored = await client.query({
      query: `SELECT
      tupleElement(arrayElement(events, 1), 'activity_id') AS calendar_id,
      tupleElement(arrayElement(events, 2), 'evidence_activity_id') AS evidence_id
      FROM ${database}.cycling_power_history_rows FINAL WHERE user_id={userId:UUID}`,
      query_params: { userId: missingUserId },
      format: "JSONEachRow",
    });
    expect(await stored.json()).toEqual([{ calendar_id: null, evidence_id: null }]);
    const result = await client.query({
      query: `SELECT toString(activity_id) AS activity_id, evidence_activity_id,
      evidence_at,evidence_duration_seconds,evidence_power FROM ${database}.cycling_threshold_history
      WHERE user_id={userId:UUID} ORDER BY event_at`,
      query_params: { userId: missingUserId },
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([
      {
        activity_id: null,
        evidence_activity_id: null,
        evidence_at: null,
        evidence_duration_seconds: null,
        evidence_power: null,
      },
      {
        activity_id: missingActivityId,
        evidence_activity_id: null,
        evidence_at: null,
        evidence_duration_seconds: null,
        evidence_power: null,
      },
    ]);
    const metrics = await client.query({
      query: `SELECT toString(activity_id) AS activity_id, evidence_activity_id,evidence_at,
      evidence_duration_seconds,evidence_power FROM ${database}.cycling_activity_power_metrics WHERE user_id={userId:UUID}`,
      query_params: { userId: missingUserId },
      format: "JSONEachRow",
    });
    expect(await metrics.json()).toEqual([
      {
        activity_id: missingActivityId,
        evidence_activity_id: null,
        evidence_at: null,
        evidence_duration_seconds: null,
        evidence_power: null,
      },
    ]);
  });
  it("builds both dbt views from an overridden analytics source schema", async () => {
    const scopedUser = randomUUID();
    const scopedActivity = randomUUID();
    await client.command({
      query: `INSERT INTO ${database}.cycling_power_observation_rows VALUES ('${scopedUser}','${scopedActivity}',220,1,'np-v1',0,10,now64(6))`,
    });
    await client.command({
      query: `INSERT INTO ${database}.cycling_power_history_rows VALUES ('${scopedUser}',1,today(),'scoped-v1',[(1000.0,'${scopedActivity}',237.0,0.9,85.0,NULL,0.0,0.0,0.0)],20,now64(6))`,
    });
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
          "cycling_threshold_history",
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
          DBT_CLICKHOUSE_HOST: url.hostname,
          DBT_CLICKHOUSE_PORT: url.port,
          DBT_CLICKHOUSE_USER: decodeURIComponent(url.username) || "default",
          DBT_CLICKHOUSE_PASSWORD: decodeURIComponent(url.password),
          UV_PROJECT_ENVIRONMENT: "../.venv-analytics",
        },
      );
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      for (const view of ["cycling_threshold_history", "cycling_activity_power_metrics"]) {
        const rows = await client.query({
          query: `SELECT eftp FROM ${targetDatabase}.${view} WHERE user_id={userId:UUID}`,
          query_params: { userId: scopedUser },
          format: "JSONEachRow",
        });
        expect(await rows.json()).toEqual([{ eftp: 237 }]);
      }
    } finally {
      await rm(artifacts, { recursive: true, force: true });
    }
  });
});
