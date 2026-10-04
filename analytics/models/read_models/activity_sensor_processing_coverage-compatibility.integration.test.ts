import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestAnalyticsTableStatement } from "../../../packages/server/src/routers/clickhouse-integration-test-models.ts";
import { readModelSql } from "../../../src/db/read-model-sql-test-helpers.ts";
import {
  activityPerformanceUserId,
  activitySensorCoverageQuerySettings,
  createActivityPerformanceFixture,
  insertPerformanceActivities,
  runActivityPerformanceModel,
} from "./activity-performance-test-helpers.ts";

function moduleClientDatabase(url: URL): string {
  return url.pathname.trim().length > 1 ? url.pathname.slice(1) : "default";
}

describe("coverage pinned adapter compatibility", () => {
  const database = `coverage_adapter_${randomUUID().replaceAll("-", "")}`;
  const url = process.env.CLICKHOUSE_URL;
  if (!url) throw new Error("CLICKHOUSE_URL is required");
  const moduleClientUrl = new URL(url);
  const moduleClientEndpoint = {
    hostname: moduleClientUrl.hostname,
    port: moduleClientUrl.port,
    protocol: moduleClientUrl.protocol,
    database: moduleClientDatabase(moduleClientUrl),
  };
  const client = createClient({ url });
  const model = "activity_sensor_processing_coverage";
  const invocation = `${database}.${model}(target_user_ids={userIds:Array(UUID)})`;

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

  it("initial canonical create accepts the required UUID user-set invocation and exposes typed schema", async () => {
    expect(moduleClientDatabase(new URL("https://example.invalid/"))).toBe("default");
    expect(moduleClientDatabase(new URL("https://example.invalid/analytics"))).toBe("analytics");
    const result = await runActivityPerformanceModel(database, model, readModelSql(`${model}.sql`));
    expect(result.runResults.results[0]?.status).toBe("success");
    expect(
      result.manifest.nodes[`model.activity_performance_test.${model}`]?.config.materialized,
    ).toBe("view");
    const node = result.manifest.nodes[`model.activity_performance_test.${model}`];
    const nativeResult = await client.query({
      query: `SELECT database, name, engine, create_table_query FROM system.tables
        WHERE database = {database:String} AND name = {model:String}`,
      query_params: { database, model },
      format: "JSONEachRow",
    });
    const nativeRelations = await nativeResult.json<{
      database: string;
      name: string;
      engine: string;
      create_table_query: string;
    }>();
    process.stdout.write(
      `${JSON.stringify({
        task6AAdapterCreateContract: {
          moduleClientEndpoint,
          childEndpoint: result.childEndpoint,
          manifestRelation: {
            database: node.database,
            schema: node.schema,
            alias: node.alias,
            relationName: node.relation_name,
            materialized: node.config.materialized,
          },
          runResults: result.runResults.results.map(
            (entry: { unique_id: string; status: string; execution_time: number }) => ({
              uniqueId: entry.unique_id,
              status: entry.status,
              executionTime: entry.execution_time,
            }),
          ),
          dbtRunSqlArtifact: result.dbtRunSql,
          nativeRelations,
        },
      })}\n`,
    );
    expect(result.childEndpoint.hostname).toBe(moduleClientEndpoint.hostname);
    expect(result.childEndpoint.port).toBe(moduleClientEndpoint.port);
    expect(result.childEndpoint.secure).toBe(moduleClientEndpoint.protocol === "https:");
    expect(result.childEndpoint.schema).toBe(database);
    expect(node.schema).toBe(database);
    expect(node.alias).toBe(model);
    expect(
      nativeRelations.map(({ database: relationDatabase, name, engine }) => ({
        database: relationDatabase,
        name,
        engine,
      })),
    ).toEqual([{ database, name: model, engine: "View" }]);
    const rows = await client.query({
      query: `SELECT user_id, model, length(pending_keys) AS pending FROM ${invocation} ORDER BY model`,
      clickhouse_settings: activitySensorCoverageQuerySettings,
      query_params: { userIds: [activityPerformanceUserId] },
      format: "JSONEachRow",
    });
    expect(await rows.json()).toEqual([
      { user_id: activityPerformanceUserId, model: "activity_heart_rate_distribution", pending: 1 },
      { user_id: activityPerformanceUserId, model: "activity_pace_curve", pending: 1 },
    ]);
    const schema = await client.query({
      query: `DESCRIBE TABLE (SELECT * FROM ${invocation})`,
      clickhouse_settings: activitySensorCoverageQuerySettings,
      query_params: { userIds: [activityPerformanceUserId] },
      format: "JSONEachRow",
    });
    const columns = await schema.json<{ name: string; type: string }>();
    expect(columns.map(({ name }) => name)).toEqual([
      "user_id",
      "model",
      "pending_keys",
      "invalid_duration_keys",
    ]);
    expect(columns.find(({ name }) => name === "pending_keys")?.type.replaceAll(/\s/g, "")).toBe(
      "Array(Tuple(activity_idUUID,source_activity_versionString,source_sensor_versionString,processing_ageString))",
    );
    process.stdout.write(
      `${JSON.stringify({
        task6AAdapter: {
          phase: "initial-create",
          status: result.runResults.results[0]?.status,
          dbtVersion: result.manifest.metadata.dbt_version,
          columns,
        },
      })}\n`,
    );
  });

  it("canonical replacement discovers the existing relation and preserves required parameter behavior", async () => {
    const result = await runActivityPerformanceModel(database, model, readModelSql(`${model}.sql`));
    expect(result.runResults.results[0]?.status).toBe("success");
    const rows = await client.query({
      query: `SELECT toString(count()) AS rows FROM ${invocation}`,
      clickhouse_settings: activitySensorCoverageQuerySettings,
      query_params: { userIds: [activityPerformanceUserId] },
      format: "JSONEachRow",
    });
    expect(await rows.json()).toEqual([{ rows: "2" }]);
    await expect(
      client.query({
        query: `SELECT * FROM ${database}.${model}`,
        format: "JSONEachRow",
      }),
    ).rejects.toMatchObject({ code: "51", type: "EMPTY_LIST_OF_COLUMNS_QUERIED" });
    const empty = await client.query({
      query: `SELECT toString(count()) AS rows FROM ${invocation}`,
      clickhouse_settings: activitySensorCoverageQuerySettings,
      query_params: { userIds: [] },
      format: "JSONEachRow",
    });
    expect(await empty.json()).toEqual([{ rows: "0" }]);
    process.stdout.write(
      `${JSON.stringify({
        task6AAdapter: {
          phase: "replace",
          status: result.runResults.results[0]?.status,
          dbtVersion: result.manifest.metadata.dbt_version,
        },
      })}\n`,
    );
  });
});
