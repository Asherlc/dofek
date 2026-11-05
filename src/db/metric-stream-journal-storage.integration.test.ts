import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createClickHouseClientFromEnv } from "./clickhouse.ts";
import { clickHouseMigrations } from "./clickhouse-migrations/registry.ts";

describe("native journal storage policy", () => {
  const client = createClickHouseClientFromEnv();
  const suffix = randomUUID().replaceAll("-", "");
  const ingest = `journal_ingest_${suffix}`;
  const analytics = `journal_analytics_${suffix}`;
  const settings = { max_memory_usage: String(128 * 1024 * 1024) };

  afterAll(async () => {
    try {
      await client.command({
        query: `DROP DATABASE IF EXISTS ${ingest} SYNC`,
        clickhouse_settings: settings,
      });
      await client.command({
        query: `DROP DATABASE IF EXISTS ${analytics} SYNC`,
        clickhouse_settings: settings,
      });
    } finally {
      await client.close();
    }
  });

  it("writes the placement view and receipts to the dedicated disk without changing the raw disk", async () => {
    const connection = process.env.TEST_DATABASE_URL;
    if (!connection) throw new Error("TEST_DATABASE_URL is required");
    const migration = clickHouseMigrations(connection).find(
      (value) => value.id === "0112_metric_stream_journal",
    );
    expect(migration, "native journal migration must be registered").toBeDefined();
    if (!migration) throw new Error("Native journal migration is missing");
    for (const statement of migration.statements)
      await client.command({
        query: statement.replaceAll(/\bingest\b/g, ingest).replaceAll(/\banalytics\b/g, analytics),
        clickhouse_settings: settings,
      });
    const sourceId = randomUUID();
    const userId = randomUUID();
    await client.command({
      query: `INSERT INTO ${ingest}.metric_stream (id,user_id,recorded_at,channel,provider_id,version,generation)
        VALUES ({source:UUID},{user:UUID},'2026-11-05 00:00:00','heart_rate','fixture',1,0)`,
      query_params: { source: sourceId, user: userId },
      clickhouse_settings: settings,
    });
    await client.command({
      query: `INSERT INTO ${analytics}.delivery_receipt
        (epoch,topic,partition,major,minor,batch,serialized_message_id,effect_count,chunk_count,effect_digest,stages)
        VALUES ('fixture','sensor',-1,1,0,-1,'CAgQAA==',0,0,repeat('0',64),['scalar'])`,
      clickhouse_settings: settings,
    });
    const placement = await client.query({
      query: `SELECT toString(source_id) AS source_id,toString(user_id) AS user_id FROM ${analytics}.source_placement`,
      format: "JSONEachRow",
      clickhouse_settings: settings,
    });
    expect(await placement.json()).toEqual([{ source_id: sourceId, user_id: userId }]);
    const policies = await client.query({
      query: `SELECT name,storage_policy FROM system.tables WHERE database={database:String}
        AND name IN ('effect_journal','effect_receipt','delivery_receipt','source_placement') ORDER BY name`,
      query_params: { database: analytics },
      format: "JSONEachRow",
      clickhouse_settings: settings,
    });
    expect(await policies.json()).toEqual(
      ["delivery_receipt", "effect_journal", "effect_receipt", "source_placement"].map((name) => ({
        name,
        storage_policy: "metric_stream_journal",
      })),
    );
    const parts = await client.query({
      query: `SELECT database,table,groupUniqArray(disk_name) AS disks FROM system.parts
        WHERE active AND (database={analytics:String} OR database={ingest:String}) GROUP BY database,table ORDER BY database,table`,
      query_params: { analytics, ingest },
      format: "JSONEachRow",
      clickhouse_settings: settings,
    });
    expect(await parts.json()).toEqual([
      { database: analytics, table: "delivery_receipt", disks: ["metric_stream_journal"] },
      { database: analytics, table: "source_placement", disks: ["metric_stream_journal"] },
      { database: ingest, table: "metric_stream", disks: ["default"] },
    ]);
  });
});
