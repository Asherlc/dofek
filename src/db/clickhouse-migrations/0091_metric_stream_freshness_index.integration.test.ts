import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createClickHouseClientFromEnv } from "../clickhouse.ts";
import { createMigration } from "./0091_metric_stream_freshness_index.ts";

const indexSchema = z.array(
  z.object({
    name: z.string(),
    expr: z.string(),
    type: z.string(),
    data_compressed_bytes: z.string(),
  }),
);

describe("0091_metric_stream_freshness_index", () => {
  const database = `metric_stream_freshness_${randomUUID().replaceAll("-", "")}`;
  const client = createClickHouseClientFromEnv();

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await client.close?.();
  });

  it("materializes an idempotent minmax index over source ingestion time", async () => {
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({
      query: `CREATE TABLE ${database}.metric_stream (
        id UInt64,
        ingested_at DateTime64(3, 'UTC')
      ) ENGINE = MergeTree ORDER BY id`,
    });
    await client.command({
      query: `INSERT INTO ${database}.metric_stream
        SELECT number, toDateTime64('2026-09-13 00:00:00', 3, 'UTC') + number / 1000
        FROM numbers(10000)`,
    });

    for (const statement of createMigration().statements) {
      const scopedStatement = statement.replaceAll("ingest.", `${database}.`);
      await client.command({ query: scopedStatement });
      await client.command({ query: scopedStatement });
    }

    const result = await client.query({
      query: `SELECT name, expr, type, toString(data_compressed_bytes) AS data_compressed_bytes
        FROM system.data_skipping_indices
        WHERE database = {database:String}
          AND table = 'metric_stream'`,
      query_params: { database },
      format: "JSONEachRow",
    });

    expect(indexSchema.parse(await result.json())).toEqual([
      {
        name: "ingested_at_minmax",
        expr: "ingested_at",
        type: "minmax",
        data_compressed_bytes: expect.not.stringMatching(/^0$/),
      },
    ]);
  });
});
