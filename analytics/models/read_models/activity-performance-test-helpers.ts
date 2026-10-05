import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClickHouseClient } from "@clickhouse/client";
import { readModelSql, renderDbtModelSql } from "../../../src/db/read-model-sql-test-helpers.ts";

export const activityPerformanceUserId = "00000000-0000-4000-8000-000000000001";

export const activitySensorCoverageQuerySettings = {
  max_threads: 1,
  join_use_nulls: 1,
  enable_materialized_cte: 1,
} as const;

export function activityPerformanceId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

/** Current final schemas only: never replay historical backfills in these fixtures. */
export async function createActivityPerformanceFixture(client: ClickHouseClient, database: string) {
  for (const query of [
    `CREATE DATABASE ${database}`,
    `CREATE TABLE ${database}.deduped_activities (
      user_id UUID, activity_id UUID, canonical_type String DEFAULT 'running',
      started_at DateTime64(6, 'UTC'), ended_at Nullable(DateTime64(6, 'UTC')),
      member_activity_ids Array(UUID),
      refresh_version UInt64 DEFAULT toUInt64(toUnixTimestamp64Nano(now64(9))), is_deleted UInt8
    ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id)`,
    `CREATE TABLE ${database}.deduped_sensor (
      user_id UUID, channel String, recorded_date Date MATERIALIZED toDate(recorded_at),
      recorded_at DateTime64(6, 'UTC'), scalar Nullable(Float64), provider_id String DEFAULT 'first',
      source_activity_id Nullable(UUID), refresh_version UInt64, is_deleted UInt8
    ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, channel, recorded_date, recorded_at)`,
    `CREATE TABLE ${database}.sensor_scalar_sample (
      id UUID, user_id UUID, recorded_at DateTime64(6, 'UTC'), channel String,
      scalar Nullable(Float64), provider_id String, provider_priority Int32,
      member_activity_id Nullable(UUID), activity_id Nullable(UUID),
      device_id Nullable(String), source_external_id Nullable(String), source_type Nullable(String),
      measurement_kind Nullable(String), _peerdb_is_deleted UInt8,
      _peerdb_synced_at DateTime64(9, 'UTC')
    ) ENGINE = MergeTree ORDER BY (user_id, channel, recorded_at, id)`,
    `CREATE TABLE ${database}.probe (
      user_id UUID, activity_id UUID, canonical_type String,
      started_at DateTime64(6, 'UTC'), ended_at DateTime64(6, 'UTC'),
      source_activity_version UInt64, source_sensor_version UInt64,
      is_deleted UInt8, refresh_version UInt64, duration_seconds UInt32 DEFAULT 0
    ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id, duration_seconds)`,
  ])
    await client.command({ query });
}

interface ActivityFixtureOptions {
  startedAt?: string;
  endedAt?: string | null;
  version?: number;
  deleted?: number;
  canonicalType?: string;
  members?: string[];
}

export async function insertPerformanceActivities(
  client: ClickHouseClient,
  database: string,
  indices: readonly number[],
  options: ActivityFixtureOptions = {},
) {
  await client.insert({
    table: `${database}.deduped_activities`,
    format: "JSONEachRow",
    values: indices.map((index) => ({
      user_id: activityPerformanceUserId,
      activity_id: activityPerformanceId(index),
      canonical_type: options.canonicalType ?? "running",
      started_at: options.startedAt ?? "2026-09-01 12:00:00",
      ended_at: options.endedAt === undefined ? "2026-09-01 13:00:00" : options.endedAt,
      member_activity_ids: options.members ?? [activityPerformanceId(index + 1000)],
      ...(options.version === undefined ? {} : { refresh_version: options.version }),
      is_deleted: options.deleted ?? 0,
    })),
  });
}

export async function insertPerformanceActivity(
  client: ClickHouseClient,
  database: string,
  index: number,
  options: ActivityFixtureOptions = {},
) {
  await insertPerformanceActivities(client, database, [index], options);
}

export async function insertPerformanceSensor(
  client: ClickHouseClient,
  database: string,
  recordedAt: string,
  options: { channel?: string; userId?: string; deleted?: number; provider?: string } = {},
) {
  // Use the actual canonical writer's clock, not arbitrary watermarks which cannot
  // arise from its serialized microbatch lifecycle.
  await client.command({
    query: `INSERT INTO ${database}.deduped_sensor
    (user_id, channel, recorded_at, scalar, provider_id, refresh_version, is_deleted)
    SELECT '${options.userId ?? activityPerformanceUserId}', '${options.channel ?? "heart_rate"}',
      toDateTime64('${recordedAt}', 6, 'UTC'), 120, '${options.provider ?? "first"}',
      toUInt64(toUnixTimestamp64Nano(now64(9))), ${options.deleted ?? 0}`,
  });
}

/** Explicit bounded canonical replay after a priority correction, using the real model. */
export async function refreshPerformanceCanonicalSensors(
  client: ClickHouseClient,
  database: string,
) {
  const sql = renderDbtModelSql(readModelSql("deduped_sensor.sql"), {
    isIncremental: true,
  }).replaceAll("{{ ref('sensor_scalar_sample') }}", `${database}.sensor_scalar_sample`);
  await client.command({
    query: `INSERT INTO ${database}.deduped_sensor
    (user_id, channel, recorded_at, scalar, provider_id, source_activity_id, refresh_version, is_deleted)
    SELECT user_id, channel, recorded_at, scalar, provider_id, source_activity_id, refresh_version, is_deleted
    FROM (${sql})`,
  });
}

/** Compile the production macro with dbt itself, then execute its SQL on ClickHouse. */
export async function compileActivityDirtyKeys(database: string, batchSize = 32) {
  return compileActivityPerformanceModel(
    database,
    "probe",
    `{{ config(materialized='incremental') }}\n{{ activity_sensor_dirty_keys('heart_rate', this, ${batchSize}) }}`,
  );
}

export async function compileActivityPerformanceModel(
  database: string,
  modelName: string,
  modelSql: string,
  variables: Record<string, unknown> = {},
) {
  const result = await executeActivityPerformanceModel(
    database,
    modelName,
    modelSql,
    variables,
    "compile",
  );
  return result.sql;
}

/** Exercise the pinned adapter's canonical materialization, including replacement. */
export async function runActivityPerformanceModel(
  database: string,
  modelName: string,
  modelSql: string,
) {
  return executeActivityPerformanceModel(database, modelName, modelSql, {}, "run");
}

/** Check the actual configured build, documentation and lint toolchain. */
export async function checkActivityPerformanceModelTooling(
  database: string,
  modelName: string,
  modelSql: string,
  command: "build" | "docs" | "lint",
) {
  return executeActivityPerformanceModel(database, modelName, modelSql, {}, command);
}

async function executeActivityPerformanceModel(
  database: string,
  modelName: string,
  modelSql: string,
  variables: Record<string, unknown>,
  command: "compile" | "run" | "build" | "docs" | "lint",
) {
  const project = await mkdtemp(join(tmpdir(), "dofek-activity-performance-"));
  try {
    await mkdir(join(project, "models"));
    await mkdir(join(project, "macros"));
    await writeFile(
      join(project, "dbt_project.yml"),
      "name: activity_performance_test\nversion: '1.0'\nconfig-version: 2\nprofile: dofek\n",
    );
    for (const model of [
      "deduped_sensor",
      "deduped_activities",
      "activity_pace_curve",
      "activity_heart_rate_distribution",
    ]) {
      if (model === modelName) continue;
      await writeFile(join(project, "models", `${model}.sql`), "SELECT 1 AS unused");
    }
    await writeFile(
      join(project, "macros", "activity_sensor_dirty_keys.sql"),
      await readFile(
        new URL("../../macros/activity_sensor_dirty_keys.sql", import.meta.url),
        "utf8",
      ),
    );
    await writeFile(join(project, "models", `${modelName}.sql`), modelSql);
    if (command === "lint") {
      const analyticsDirectory = fileURLToPath(new URL("../..", import.meta.url));
      const config = await readFile(join(analyticsDirectory, ".sqlfluff"), "utf8");
      await writeFile(
        join(project, ".sqlfluff"),
        config
          .replace("project_dir = .", `project_dir = ${project}`)
          .replace("profiles_dir = .", `profiles_dir = ${analyticsDirectory}`),
      );
    }
    const url = new URL(process.env.CLICKHOUSE_URL ?? "");
    const childEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      UV_PROJECT_ENVIRONMENT: "../.venv-analytics",
      DBT_TARGET: "dev",
      DBT_CLICKHOUSE_SCHEMA: database,
      DBT_CLICKHOUSE_HOST: url.hostname,
      DBT_CLICKHOUSE_PORT: url.port,
      DBT_CLICKHOUSE_USER: decodeURIComponent(url.username),
      DBT_CLICKHOUSE_PASSWORD: decodeURIComponent(url.password),
    };
    const childEndpoint = {
      hostname: childEnvironment.DBT_CLICKHOUSE_HOST,
      port: childEnvironment.DBT_CLICKHOUSE_PORT,
      schema: childEnvironment.DBT_CLICKHOUSE_SCHEMA,
      target: childEnvironment.DBT_TARGET,
      secure: (childEnvironment.DBT_CLICKHOUSE_SECURE ?? "false").toLowerCase() === "true",
    };
    const result = await new Promise<{ code: number; output: string }>((resolve, reject) => {
      const child = spawn(
        "uv",
        command === "lint"
          ? [
              "run",
              "--project",
              "analytics",
              "sqlfluff",
              "lint",
              "--ignore",
              "parsing",
              "--config",
              join(project, ".sqlfluff"),
              join(project, "models", `${modelName}.sql`),
            ]
          : [
              "run",
              "--project",
              "analytics",
              "dbt",
              ...(command === "docs" ? ["docs", "generate"] : [command]),
              "--project-dir",
              project,
              "--profiles-dir",
              "analytics",
              "--select",
              modelName,
              "--target-path",
              join(project, "target"),
              "--log-path",
              join(project, "logs"),
              "--no-use-colors",
              "--vars",
              JSON.stringify(variables),
            ],
        {
          env: childEnvironment,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code: code ?? 1, output }));
    });
    if (result.code !== 0) {
      throw new Error(
        `${command === "lint" ? "SQLFluff lint" : `dbt ${command}`} failed: ${result.output}`,
      );
    }
    if (command === "lint") {
      return {
        sql: modelSql,
        dbtRunSql: null,
        childEndpoint,
        output: result.output,
        manifest: null,
        runResults: null,
        catalog: null,
      };
    }
    const sql = await readFile(
      join(
        project,
        "target",
        "compiled",
        "activity_performance_test",
        "models",
        `${modelName}.sql`,
      ),
      "utf8",
    );
    return {
      sql,
      dbtRunSql:
        command === "run" || command === "build"
          ? await readFile(
              join(
                project,
                "target",
                "run",
                "activity_performance_test",
                "models",
                `${modelName}.sql`,
              ),
              "utf8",
            )
          : null,
      childEndpoint,
      output: result.output,
      manifest: JSON.parse(await readFile(join(project, "target", "manifest.json"), "utf8")),
      runResults:
        command === "docs"
          ? null
          : JSON.parse(await readFile(join(project, "target", "run_results.json"), "utf8")),
      catalog:
        command === "docs"
          ? JSON.parse(await readFile(join(project, "target", "catalog.json"), "utf8"))
          : null,
    };
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}

export async function persistActivityDirtyKeys(
  client: ClickHouseClient,
  database: string,
  sql: string,
) {
  await client.command({
    query: `INSERT INTO ${database}.probe
    (user_id, activity_id, canonical_type, started_at, ended_at, source_activity_version,
      source_sensor_version, is_deleted, refresh_version)
    SELECT user_id, activity_id, canonical_type, started_at, ended_at,
      source_activity_version, source_sensor_version, source_is_deleted AS is_deleted,
      toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version
    FROM (${sql}) SETTINGS join_use_nulls = 1, enable_materialized_cte = 1`,
  });
}
