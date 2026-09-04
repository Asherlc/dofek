import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../clickhouse.ts";
import { createMigration } from "./0072_canonical_clinical_records.ts";

const columnSchema = z.array(z.object({ name: z.string() }));
const providerKeySchema = z.array(
  z.object({ provider_id: z.string(), user_id: z.string().uuid() }),
);

describe("0072_canonical_clinical_records migration", () => {
  const suffix = randomUUID().replaceAll("-", "");
  const analyticsDatabase = `clinical_upgrade_analytics_${suffix}`;
  const rawDatabase = `clinical_upgrade_raw_${suffix}`;
  const bootstrapAnalyticsDatabase = `clinical_bootstrap_analytics_${suffix}`;
  const bootstrapRawDatabase = `clinical_bootstrap_raw_${suffix}`;
  let client: ClickHouseClient;

  beforeAll(async () => {
    client = createClickHouseClientFromEnv();
    await client.command({ query: `CREATE DATABASE ${analyticsDatabase}` });
    await client.command({ query: `CREATE DATABASE ${rawDatabase}` });
  });

  afterAll(async () => {
    await client?.command({ query: `DROP DATABASE IF EXISTS ${analyticsDatabase}` });
    await client?.command({ query: `DROP DATABASE IF EXISTS ${rawDatabase}` });
    await client?.command({ query: `DROP DATABASE IF EXISTS ${bootstrapAnalyticsDatabase}` });
    await client?.command({ query: `DROP DATABASE IF EXISTS ${bootstrapRawDatabase}` });
  });

  it("bootstraps the canonical raw clinical table before querying it", async () => {
    await client.command({ query: `CREATE DATABASE ${bootstrapAnalyticsDatabase}` });
    await client.command({ query: `CREATE DATABASE ${bootstrapRawDatabase}` });
    await client.command({
      query: `CREATE TABLE ${bootstrapAnalyticsDatabase}.provider_change_state (
        user_id UUID,
        provider_id String,
        changed_at SimpleAggregateFunction(max, DateTime64(9, 'UTC'))
      ) ENGINE = AggregatingMergeTree
      ORDER BY (user_id, provider_id)`,
    });

    for (const migrationStatement of createMigration().statements) {
      await client.command({
        query: migrationStatement
          .replaceAll("analytics.", `${bootstrapAnalyticsDatabase}.`)
          .replaceAll("postgres_fitness.", `${bootstrapRawDatabase}.`),
      });
    }

    const result = await client.query({
      query: `SELECT name FROM system.tables
        WHERE database = {database:String} AND name = 'clinical_record'`,
      query_params: { database: bootstrapRawDatabase },
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([{ name: "clinical_record" }]);
  });

  it("upgrades a deployed legacy provider-stats table and queues canonical recounts", async () => {
    const legacyUserId = randomUUID();
    const clinicalUserId = randomUUID();
    await client.command({
      query: `CREATE TABLE ${analyticsDatabase}.provider_stats (
        user_id UUID,
        provider_id String,
        activities UInt64,
        daily_metrics UInt64,
        sleep_sessions UInt64,
        body_measurements UInt64,
        food_entries UInt64,
        health_events UInt64,
        metric_stream UInt64,
        nutrition_daily UInt64,
        lab_panels UInt64,
        lab_results UInt64,
        journal_entries UInt64,
        is_deleted UInt8,
        refresh_version UInt64,
        refreshed_at DateTime64(9, 'UTC')
      ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, provider_id)`,
    });
    await client.command({
      query: `INSERT INTO ${analyticsDatabase}.provider_stats VALUES
        ({legacyUserId:UUID}, 'legacy-provider', 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 0, 0, 1, now64(9))`,
      query_params: { legacyUserId },
    });
    await client.command({
      query: `CREATE TABLE ${analyticsDatabase}.provider_change_state (
        user_id UUID,
        provider_id String,
        changed_at SimpleAggregateFunction(max, DateTime64(9, 'UTC'))
      ) ENGINE = AggregatingMergeTree
      ORDER BY (user_id, provider_id)`,
    });
    await client.command({
      query: `CREATE TABLE ${rawDatabase}.clinical_record (
        user_id UUID,
        provider_id String,
        _peerdb_is_deleted Int8,
        _peerdb_version Int64
      ) ENGINE = ReplacingMergeTree(_peerdb_version)
      ORDER BY (user_id, provider_id)`,
    });
    await client.command({
      query: `INSERT INTO ${rawDatabase}.clinical_record VALUES
        ({clinicalUserId:UUID}, 'clinical-provider', 0, 1)`,
      query_params: { clinicalUserId },
    });

    for (const migrationStatement of createMigration().statements) {
      await client.command({
        query: migrationStatement
          .replaceAll("analytics.", `${analyticsDatabase}.`)
          .replaceAll("postgres_fitness.", `${rawDatabase}.`),
      });
    }

    const columnsResult = await client.query({
      query: `SELECT name
        FROM system.columns
        WHERE database = {database:String} AND table = 'provider_stats'
        ORDER BY position`,
      query_params: { database: analyticsDatabase },
      format: "JSONEachRow",
    });
    expect(columnSchema.parse(await columnsResult.json()).map((row) => row.name)).toEqual([
      "user_id",
      "provider_id",
      "activities",
      "daily_metrics",
      "sleep_sessions",
      "body_measurements",
      "food_entries",
      "health_events",
      "metric_stream",
      "nutrition_daily",
      "clinical_records",
      "journal_entries",
      "is_deleted",
      "refresh_version",
      "refreshed_at",
    ]);

    const keysResult = await client.query({
      query: `SELECT toString(user_id) AS user_id, provider_id
        FROM ${analyticsDatabase}.provider_change_state
        GROUP BY user_id, provider_id
        ORDER BY provider_id`,
      format: "JSONEachRow",
    });
    expect(providerKeySchema.parse(await keysResult.json())).toEqual([
      { provider_id: "clinical-provider", user_id: clinicalUserId },
      { provider_id: "legacy-provider", user_id: legacyUserId },
    ]);
  });
});
