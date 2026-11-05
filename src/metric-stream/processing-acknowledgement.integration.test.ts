import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClickHouseClientFromEnv } from "../db/clickhouse.ts";
import { clickHouseMigrations } from "../db/clickhouse-migrations/registry.ts";
import { buildMetricStreamProcessingAcknowledgementTableSql } from "./clickhouse-table.ts";

describe("processing acknowledgement transport evidence", () => {
  const client = createClickHouseClientFromEnv();
  const database = `marker_evidence_${randomUUID().replaceAll("-", "")}`;
  const table = `${database}.metric_stream_processing_acknowledgement`;
  const settings = { max_memory_usage: String(128 * 1024 * 1024) };
  const operationId = randomUUID();

  beforeAll(async () => {
    await client.command({ query: `CREATE DATABASE ${database}`, clickhouse_settings: settings });
    await client.command({
      query: buildMetricStreamProcessingAcknowledgementTableSql().replaceAll(
        "ingest.metric_stream_processing_acknowledgement",
        table,
      ),
      clickhouse_settings: settings,
    });
  });

  afterAll(async () => {
    try {
      await client.command({
        query: `DROP DATABASE ${database} SYNC`,
        clickhouse_settings: settings,
      });
    } finally {
      await client.close();
    }
  });

  const insert = (batch: string, position: string) =>
    client.command({
      query: `INSERT INTO ${table}
      (operation_id,batch_id,dataset_keys,expected_event_count,topic,topic_partition,
       marker_offset,marker_transport,marker_epoch,marker_message_id)
      VALUES ({operation:UUID},{batch:String},['metric_stream'],1,'sensor',-1,${position})`,
      query_params: { operation: operationId, batch },
      clickhouse_settings: settings,
    });

  it("stores native identity without inventing a Kafka offset", async () => {
    await insert("native", "NULL,'pulsar','epoch-1','CAgQAA=='");
    const result = await client.query({
      query: `SELECT marker_offset,marker_transport,marker_epoch,marker_message_id FROM ${table}
        WHERE batch_id='native'`,
      format: "JSONEachRow",
      clickhouse_settings: settings,
    });
    expect(await result.json()).toEqual([
      {
        marker_offset: null,
        marker_transport: "pulsar",
        marker_epoch: "epoch-1",
        marker_message_id: "CAgQAA==",
      },
    ]);
  });

  it.each([
    "42,'pulsar','epoch-1','CAgQAA=='",
    "NULL,'kafka',NULL,NULL",
    "42,'kafka','epoch-1','CAgQAA=='",
    "NULL,'pulsar',NULL,'CAgQAA=='",
    "NULL,'pulsar','epoch-1',NULL",
    "NULL,'pulsar','','CAgQAA=='",
    "NULL,'pulsar','epoch-1',''",
  ])("rejects mixed or incomplete native evidence: %s", async (position) => {
    await expect(insert(randomUUID(), position)).rejects.toThrow(/constraint/i);
  });

  it("migrates existing Kafka evidence without changing its offset and permits native evidence", async () => {
    const legacy = `${database}.legacy_acknowledgement`;
    await client.command({
      query: `CREATE TABLE ${legacy} (
        operation_id UUID,batch_id String,dataset_keys Array(String),expected_event_count UInt64,
        topic String,topic_partition Int32,marker_offset UInt64,
        applied_at DateTime64(9) DEFAULT now64(9)
      ) ENGINE=ReplacingMergeTree(applied_at) ORDER BY (operation_id,batch_id)`,
      clickhouse_settings: settings,
    });
    await client.command({
      query: `INSERT INTO ${legacy} (operation_id,batch_id,dataset_keys,expected_event_count,topic,topic_partition,marker_offset)
        VALUES ({operation:UUID},'legacy',['metric_stream'],1,'sensor',0,18446744073709551615)`,
      query_params: { operation: operationId },
      clickhouse_settings: settings,
    });
    const connection = process.env.TEST_DATABASE_URL;
    if (!connection) throw new Error("TEST_DATABASE_URL is required");
    const migration = clickHouseMigrations(connection).find(
      (value) => value.id === "0111_native_processing_acknowledgement",
    );
    expect(migration, "native acknowledgement migration must be registered").toBeDefined();
    if (!migration) throw new Error("Native acknowledgement migration is missing");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      for (const statement of migration.statements)
        await client.command({
          query: statement.replaceAll("ingest.metric_stream_processing_acknowledgement", legacy),
          clickhouse_settings: settings,
        });
    }
    await client.command({
      query: `INSERT INTO ${legacy} (operation_id,batch_id,dataset_keys,expected_event_count,topic,topic_partition,marker_offset)
        VALUES ({operation:UUID},'legacy-after',['metric_stream'],1,'sensor',0,42)`,
      query_params: { operation: operationId },
      clickhouse_settings: settings,
    });
    await client.command({
      query: `INSERT INTO ${legacy} (operation_id,batch_id,dataset_keys,expected_event_count,topic,topic_partition,
        marker_transport,marker_epoch,marker_message_id) VALUES
        ({operation:UUID},'native',['metric_stream'],1,'sensor',-1,'pulsar','epoch-1','CAgQAA==')`,
      query_params: { operation: operationId },
      clickhouse_settings: settings,
    });
    const result = await client.query({
      query: `SELECT batch_id,toString(marker_offset) AS marker_offset,marker_transport,marker_epoch,marker_message_id
        FROM ${legacy} ORDER BY batch_id`,
      format: "JSONEachRow",
      clickhouse_settings: settings,
    });
    expect(await result.json()).toEqual([
      {
        batch_id: "legacy",
        marker_offset: "18446744073709551615",
        marker_transport: "kafka",
        marker_epoch: null,
        marker_message_id: null,
      },
      {
        batch_id: "legacy-after",
        marker_offset: "42",
        marker_transport: "kafka",
        marker_epoch: null,
        marker_message_id: null,
      },
      {
        batch_id: "native",
        marker_offset: null,
        marker_transport: "pulsar",
        marker_epoch: "epoch-1",
        marker_message_id: "CAgQAA==",
      },
    ]);
  });
});
