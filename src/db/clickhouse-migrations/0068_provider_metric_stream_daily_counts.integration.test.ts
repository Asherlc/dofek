import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../clickhouse.ts";
import { createMigration } from "./0068_provider_metric_stream_daily_counts.ts";

const markerRowsSchema = z.array(
  z.object({
    changed_at: z.coerce.bigint(),
    provider_id: z.string(),
    recorded_date: z.string(),
  }),
);

describe("0068_provider_metric_stream_daily_counts migration", () => {
  const database = `provider_metric_stream_daily_counts_${randomUUID().replaceAll("-", "")}`;
  let client: ClickHouseClient;

  beforeAll(async () => {
    client = createClickHouseClientFromEnv();
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({
      query: `CREATE TABLE ${database}.metric_stream (
        user_id UUID,
        provider_id String,
        id UUID,
        recorded_at DateTime64(6, 'UTC'),
        ingested_at DateTime64(9, 'UTC'),
        version Int64,
        is_deleted Int8
      )
      ENGINE = ReplacingMergeTree(version)
      ORDER BY (user_id, provider_id, id)`,
    });

    for (const statement of createMigration().statements) {
      let replacement = statement.replaceAll("analytics.", `${database}.`);
      replacement = replacement.replaceAll("ingest.metric_stream", `${database}.metric_stream`);
      await client.command({ query: replacement });
    }
  });

  afterAll(async () => {
    await client?.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await client?.close?.();
  });

  it("marks the recorded day again when a metric tombstone arrives", async () => {
    const userId = randomUUID();
    const metricId = randomUUID();

    await client.command({
      query: `INSERT INTO ${database}.metric_stream VALUES (
        {userId:UUID},
        'test_provider',
        {metricId:UUID},
        '2026-08-01 10:00:00',
        '2026-08-01 10:01:00',
        1,
        0
      )`,
      query_params: { metricId, userId },
    });

    const markerQuery = `SELECT
      provider_id,
      toString(recorded_date) AS recorded_date,
      toUnixTimestamp64Nano(max(changed_at)) AS changed_at
    FROM ${database}.metric_stream_day_change
    WHERE user_id = {userId:UUID}
    GROUP BY provider_id, recorded_date
    ORDER BY provider_id, recorded_date`;
    const initialResult = await client.query({
      query: markerQuery,
      query_params: { userId },
      format: "JSONEachRow",
    });
    const initialRows = markerRowsSchema.parse(await initialResult.json());
    expect(initialRows).toHaveLength(1);

    await client.command({
      query: `INSERT INTO ${database}.metric_stream VALUES (
          {userId:UUID},
          'test_provider',
          {metricId:UUID},
          '2026-08-01 10:00:00',
          '2026-08-01 10:02:00',
          2,
          1
        )`,
      query_params: { metricId, userId },
    });

    const result = await client.query({
      query: markerQuery,
      query_params: { userId },
      format: "JSONEachRow",
    });

    const tombstoneRows = markerRowsSchema.parse(await result.json());
    expect(tombstoneRows).toHaveLength(1);
    expect(tombstoneRows[0]).toMatchObject({
      provider_id: "test_provider",
      recorded_date: "2026-08-01",
    });
    expect(tombstoneRows[0]?.changed_at).toBeGreaterThan(initialRows[0]?.changed_at ?? 0n);
  });
});
