import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../clickhouse.ts";
import { buildActivitySummaryRowsTableSql } from "../clickhouse-activity-summary.ts";
import { buildClickHouseBootstrapStatementsForNativeMetricStream } from "../clickhouse-metric-stream-bootstrap.ts";
import { createMigration } from "./0108_computed_cycling_power.ts";

describe("computed cycling power schema upgrade", () => {
  const database = `power_upgrade_${randomUUID().replaceAll("-", "")}`;
  const rawDatabase = `${database}_raw`;
  const actual = createClickHouseClientFromEnv();
  const rewrite = (query: string) =>
    query
      .replaceAll("analytics.", `${database}.`)
      .replaceAll("postgres_fitness.", `${rawDatabase}.`);
  const client: ClickHouseClient = {
    command: (options) => actual.command({ ...options, query: rewrite(options.query) }),
    query: (options) =>
      actual.query({
        ...options,
        query: rewrite(options.query),
        query_params: {
          ...options.query_params,
          ...(options.query_params?.database === "analytics" ? { database } : {}),
        },
      }),
  };
  const userId = randomUUID();
  const activityId = randomUUID();
  beforeAll(async () => {
    await actual.command({ query: `CREATE DATABASE ${database}` });
    await actual.command({ query: `CREATE DATABASE ${rawDatabase}` });
    await client.command({ query: buildActivitySummaryRowsTableSql() });
    for (const table of ["activity_sensor_summary_rows", "cycling_activity"]) {
      await client.command({
        query: `CREATE TABLE analytics.${table} (activity_id UUID,normalized_power Nullable(Float64)) ENGINE=MergeTree ORDER BY activity_id`,
      });
    }
    await client.command({
      query:
        "ALTER TABLE analytics.activity_summary_rows ADD COLUMN normalized_power Nullable(Float64)",
    });
    await client.command({
      query:
        "CREATE TABLE analytics.daily_cycling (user_id UUID,date Date,activities Array(Tuple(UUID,DateTime64(6,'UTC'),Float64,Float64,Float64,Nullable(Float64),UInt64,UInt64,Nullable(Float64),Nullable(String))),is_deleted UInt8,refresh_version UInt64,refreshed_at DateTime64(9,'UTC')) ENGINE=ReplacingMergeTree(refresh_version) ORDER BY (user_id,date)",
    });
    await client.command({
      query:
        "CREATE TABLE analytics.healthspan_activity_zone_minutes (activity_id UUID,aerobic_minutes Float64,high_intensity_minutes Float64) ENGINE=MergeTree ORDER BY activity_id",
    });
    await client.command({
      query:
        "CREATE TABLE analytics.weekly_healthspan (user_id UUID,weekly_aerobic_min Float64,weekly_high_intensity_min Float64) ENGINE=MergeTree ORDER BY user_id",
    });
    await client.command({
      query:
        "CREATE TABLE postgres_fitness.user_profile (id UUID,name String,email Nullable(String),birth_date Nullable(Date),max_hr Nullable(Int16),resting_hr Nullable(Int16),ftp Nullable(Int16),is_admin Bool,created_at DateTime64(6,'UTC'),updated_at DateTime64(6,'UTC'),_peerdb_is_deleted Int8,_peerdb_version UInt64) ENGINE=ReplacingMergeTree(_peerdb_version) ORDER BY id",
    });
    await client.command({
      query: `INSERT INTO analytics.activity_summary_rows (user_id,activity_id,canonical_type,started_at,ended_at,normalized_power,refresh_version,is_deleted,refreshed_at) VALUES ('${userId}','${activityId}','cycling','2026-01-01 12:00:00','2026-01-01 13:00:00',999,20,0,now64(9))`,
    });
    await client.command({
      query:
        "CREATE VIEW analytics.activity_summary AS SELECT activity_id,normalized_power FROM analytics.activity_summary_rows FINAL",
    });
    await client.command({
      query: `INSERT INTO analytics.daily_cycling VALUES ('${userId}',today(),[('${activityId}',now64(6),60.0,130.0,160.0,220.0,toUInt64(3600),toUInt64(3600),999.0,'Legacy ride')],0,1,now64(9))`,
    });
    await client.command({
      query: `INSERT INTO postgres_fitness.user_profile VALUES ('${userId}','Rider',NULL,NULL,180,50,300,false,now64(6),now64(6),0,1)`,
    });
    await client.command({
      query:
        "CREATE VIEW postgres_fitness.user_profile_current AS SELECT id,name,ftp FROM postgres_fitness.user_profile FINAL WHERE _peerdb_is_deleted=0",
    });
  });
  afterAll(async () => {
    await actual.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await actual.command({ query: `DROP DATABASE IF EXISTS ${rawDatabase}` });
    for (const suffix of ["analytics", "postgres_fitness", "ingest"]) {
      await actual.command({ query: `DROP DATABASE IF EXISTS ${database}_fresh_${suffix}` });
    }
    await actual.close?.();
  });
  it("bootstraps the real canonical views before serving an observation on a fresh database", async () => {
    const fresh = (query: string) =>
      query.replace(
        /\b(analytics|postgres_fitness|ingest)\b/g,
        (name) => `${database}_fresh_${name}`,
      );
    for (const query of buildClickHouseBootstrapStatementsForNativeMetricStream("")) {
      await actual.command({ query: fresh(query) });
    }
    await actual.command({
      query: fresh(
        `INSERT INTO analytics.activity_summary_rows (user_id,activity_id,canonical_type,started_at,ended_at,refresh_version,is_deleted,refreshed_at) VALUES ('${userId}','${activityId}','running','2026-01-01 12:00:00','2026-01-01 13:00:00',20,0,now64(9))`,
      ),
    });
    await actual.command({
      query: fresh(
        `INSERT INTO analytics.cycling_power_observation_rows VALUES ('${userId}','${activityId}',210,20,'np-v1',0,100,now64(6))`,
      ),
    });
    const summary = await actual.query({
      query: fresh("SELECT normalized_power FROM analytics.activity_summary"),
      format: "JSONEachRow",
    });
    expect(await summary.json()).toEqual([{ normalized_power: 210 }]);
  });
  it("serves only newly published canonical power after upgrading populated legacy tables and rerunning", async () => {
    const migration = createMigration();
    await migration.run?.(client, "");
    await client.command({
      query: `INSERT INTO analytics.cycling_power_observation_rows VALUES ('${userId}','${activityId}',220,20,'np-v1',0,100,now64(6))`,
    });
    await client.command({
      query: `INSERT INTO analytics.cycling_power_history_rows VALUES ('${userId}',20,today(),'bank-v1',[(1000.0,'${activityId}',250.0,0.88,77.44,'${activityId}',1000.0,1200.0,265.0)],200,now64(6))`,
    });
    await migration.run?.(client, "");
    const result = await client.query({
      query: "SELECT normalized_power,eftp,power_tss FROM analytics.cycling_activity_power_metrics",
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([{ normalized_power: 220, eftp: 250, power_tss: 77.44 }]);
    const summary = await client.query({
      query: "SELECT normalized_power FROM analytics.activity_summary",
      format: "JSONEachRow",
    });
    expect(await summary.json()).toEqual([{ normalized_power: 220 }]);
    const profile = await client.query({
      query: "SELECT name,max_hr FROM postgres_fitness.user_profile_current",
      format: "JSONEachRow",
    });
    expect(await profile.json()).toEqual([{ name: "Rider", max_hr: 180 }]);
    await client.command({
      query: `INSERT INTO analytics.healthspan_activity_zone_minutes VALUES ('${activityId}',NULL,NULL)`,
    });
    await client.command({
      query: `INSERT INTO analytics.weekly_healthspan VALUES ('${userId}',NULL,NULL)`,
    });
    await client.command({
      query: `INSERT INTO analytics.daily_cycling VALUES ('${userId}',today(),[('${activityId}',now64(6),60.0,NULL,NULL,220.0,toUInt64(3600),toUInt64(0),'Power ride')],0,1,now64(9))`,
    });
    await migration.run?.(client, "");
    const daily = await client.query({
      query: "SELECT activities[1].9 AS name FROM analytics.daily_cycling FINAL",
      format: "JSONEachRow",
    });
    expect(await daily.json()).toEqual([{ name: "Power ride" }]);
  });
});
