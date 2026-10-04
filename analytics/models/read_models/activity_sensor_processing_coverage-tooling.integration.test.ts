import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestAnalyticsTableStatement } from "../../../packages/server/src/routers/clickhouse-integration-test-models.ts";
import { readModelSql } from "../../../src/db/read-model-sql-test-helpers.ts";
import { parseDbtRunArtifacts } from "../../../src/processing/dbt-run-results.ts";
import {
  activityPerformanceUserId,
  activitySensorCoverageQuerySettings,
  checkActivityPerformanceModelTooling,
  createActivityPerformanceFixture,
  insertPerformanceActivities,
} from "./activity-performance-test-helpers.ts";

describe("coverage configured tooling compatibility", () => {
  const database = `coverage_tooling_${randomUUID().replaceAll("-", "")}`;
  const url = process.env.CLICKHOUSE_URL;
  if (!url) throw new Error("CLICKHOUSE_URL is required");
  const client = createClient({ url });
  const model = "activity_sensor_processing_coverage";
  const sql = readModelSql(`${model}.sql`);
  beforeAll(async () => {
    await createActivityPerformanceFixture(client, database);
    for (const name of ["activity_pace_curve", "activity_heart_rate_distribution"]) {
      await client.command({
        query: buildTestAnalyticsTableStatement(`analytics.${name}`).replaceAll(
          "analytics.",
          `${database}.`,
        ),
      });
    }
    await insertPerformanceActivities(client, database, [1], { version: 41 });
  });
  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close?.();
  });

  it("canonical build emits artifacts accepted by the existing processing consumer", async () => {
    const result = await checkActivityPerformanceModelTooling(database, model, sql, "build");
    const parsed = parseDbtRunArtifacts({
      manifest: result.manifest,
      runResults: result.runResults,
      sources: {
        metadata: { dbt_schema_version: "https://schemas.getdbt.com/dbt/sources/v3.json" },
        results: [],
      },
      selectedModels: [model],
    });
    expect(parsed.succeeded).toBe(true);
    expect(parsed.models[0]?.status).toBe("succeeded");
    const rows = await client.query({
      query: `SELECT toString(count()) AS rows FROM ${database}.${model}(target_user_ids={userIds:Array(UUID)})`,
      clickhouse_settings: activitySensorCoverageQuerySettings,
      query_params: { userIds: [activityPerformanceUserId] },
      format: "JSONEachRow",
    });
    expect(await rows.json()).toEqual([{ rows: "2" }]);
    process.stdout.write(
      `${JSON.stringify({
        task6ATooling: {
          phase: "build",
          parsed,
          output: result.output,
        },
      })}\n`,
    );
  });

  it("generates documentation with the existing adapter and records actual catalog metadata", async () => {
    const result = await checkActivityPerformanceModelTooling(database, model, sql, "docs");
    expect(result.manifest.nodes[`model.activity_performance_test.${model}`]?.name).toBe(model);
    const catalog = result.catalog;
    process.stdout.write(
      `${JSON.stringify({
        task6ATooling: {
          phase: "docs-generate",
          catalog,
          output: result.output,
        },
      })}\n`,
    );
    expect(catalog.metadata.dbt_version).toBe("1.11.12");
    expect(catalog.errors ?? []).toEqual([]);
  });

  it("templates and lints the parameterized model with the pinned SQLFluff configuration", async () => {
    const result = await checkActivityPerformanceModelTooling(database, model, sql, "lint");
    process.stdout.write(
      `${JSON.stringify({
        task6ATooling: {
          phase: "sqlfluff",
          output: result.output,
        },
      })}\n`,
    );
  });
});
