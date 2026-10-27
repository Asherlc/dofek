import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildIngestMetricStreamCreateTableSql,
  METRIC_STREAM_PROVIDER_CURRENT_STATE_RECORDED_AT_PROJECTION,
} from "../../metric-stream/clickhouse-table.ts";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../clickhouse.ts";
import { createMigration } from "./0068_provider_metric_stream_daily_counts.ts";

const markerRowsSchema = z.array(
  z.object({
    changed_at: z.coerce.bigint(),
    provider_id: z.string(),
    recorded_date: z.string(),
    user_id: z.string(),
  }),
);
const projectionRowsSchema = z.array(
  z.object({
    id: z.string(),
    ingested_at: z.string(),
    is_deleted: z.coerce.number().int(),
    recorded_at: z.string(),
    version: z.coerce.number().int(),
  }),
);

describe("0068_provider_metric_stream_daily_counts migration", () => {
  const database = `provider_metric_stream_daily_counts_${randomUUID().replaceAll("-", "")}`;
  let client: ClickHouseClient;

  beforeAll(async () => {
    client = createClickHouseClientFromEnv();
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({
      query: buildIngestMetricStreamCreateTableSql().replace(
        "ingest.metric_stream",
        `${database}.metric_stream`,
      ),
    });
    await client.command({
      query: `ALTER TABLE ${database}.metric_stream
        DROP PROJECTION IF EXISTS ${METRIC_STREAM_PROVIDER_CURRENT_STATE_RECORDED_AT_PROJECTION}`,
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
      query: `INSERT INTO ${database}.metric_stream
        (id, user_id, recorded_at, channel, provider_id, ingested_at, version, is_deleted)
      VALUES (
        {metricId:UUID},
        {userId:UUID},
        '2026-08-01 10:00:00',
        'heart_rate',
        'test_provider',
        '2026-08-01 10:01:00',
        1,
        0
      )`,
      query_params: { metricId, userId },
    });

    const markerQuery = `SELECT
      toString(user_id) AS user_id,
      provider_id,
      toString(recorded_date) AS recorded_date,
      toUnixTimestamp64Nano(max(changed_at)) AS changed_at
    FROM ${database}.metric_stream_day_change
    WHERE ${database}.metric_stream_day_change.user_id = {userId:UUID}
    GROUP BY user_id, provider_id, recorded_date
    ORDER BY user_id, provider_id, recorded_date`;
    const initialResult = await client.query({
      query: markerQuery,
      query_params: { userId },
      format: "JSONEachRow",
    });
    const initialRows = markerRowsSchema.parse(await initialResult.json());
    expect(initialRows).toHaveLength(1);

    await client.command({
      query: `INSERT INTO ${database}.metric_stream
        (id, user_id, recorded_at, channel, provider_id, ingested_at, version, is_deleted)
      VALUES (
        {metricId:UUID},
        {userId:UUID},
        '2026-08-01 10:00:00',
        'heart_rate',
        'test_provider',
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

    await client.command({
      query: `INSERT INTO ${database}.metric_stream
        (id, user_id, recorded_at, channel, provider_id, ingested_at, version, is_deleted)
      VALUES (
        {metricId:UUID},
        {userId:UUID},
        '2026-07-31 23:59:59',
        'heart_rate',
        'test_provider',
        '2026-08-01 10:03:00',
        3,
        0
      )`,
      query_params: { metricId, userId },
    });

    const backdatedResult = await client.query({
      query: markerQuery,
      query_params: { userId },
      format: "JSONEachRow",
    });
    expect(markerRowsSchema.parse(await backdatedResult.json())).toEqual([
      expect.objectContaining({
        provider_id: "test_provider",
        recorded_date: "2026-07-31",
        user_id: userId,
      }),
      expect.objectContaining({
        provider_id: "test_provider",
        recorded_date: "2026-08-01",
        user_id: userId,
      }),
    ]);
  });

  it("resolves latest metric state by version and ingestion time through the covering projection", async () => {
    const userId = randomUUID();
    const resurrectedId = randomUUID();
    const sameVersionId = randomUUID();

    await client.command({
      query: `INSERT INTO ${database}.metric_stream
        (id, user_id, recorded_at, channel, provider_id, ingested_at, version, is_deleted)
      VALUES
        ({resurrectedId:UUID}, {userId:UUID}, '2026-08-01 08:00:00', 'heart_rate', 'test_provider', '2026-08-01 09:00:00', 1, 0),
        ({resurrectedId:UUID}, {userId:UUID}, '2026-08-02 08:00:00', 'heart_rate', 'test_provider', '2026-08-01 10:00:00', 2, 1),
        ({resurrectedId:UUID}, {userId:UUID}, '2026-08-03 08:00:00', 'heart_rate', 'test_provider', '2026-08-01 11:00:00', 3, 0),
        ({sameVersionId:UUID}, {userId:UUID}, '2026-08-04 08:00:00', 'heart_rate', 'test_provider', '2026-08-01 12:00:00', 5, 0),
        ({sameVersionId:UUID}, {userId:UUID}, '2026-08-05 08:00:00', 'heart_rate', 'test_provider', '2026-08-01 13:00:00', 5, 1)`,
      query_params: { resurrectedId, sameVersionId, userId },
    });

    const result = await client.query({
      query: `SELECT
        toString(id) AS id,
        toString(latest.1) AS recorded_at,
        toString(latest.2) AS ingested_at,
        latest.3 AS version,
        latest.4 AS is_deleted
      FROM (
        SELECT
          id,
          argMax(
            tuple(recorded_at, ingested_at, version, is_deleted),
            tuple(version, ingested_at)
          ) AS latest
        FROM ${database}.metric_stream
        WHERE user_id = {userId:UUID}
          AND provider_id = 'test_provider'
          AND recorded_at >= '2026-08-01 00:00:00'
          AND recorded_at < '2026-08-06 00:00:00'
        GROUP BY user_id, provider_id, id
      )
      ORDER BY recorded_at`,
      query_params: { userId },
      format: "JSONEachRow",
    });

    expect(projectionRowsSchema.parse(await result.json())).toEqual([
      {
        id: resurrectedId,
        recorded_at: "2026-08-03 08:00:00.000000",
        ingested_at: "2026-08-01 11:00:00.000000000",
        version: 3,
        is_deleted: 0,
      },
      {
        id: sameVersionId,
        recorded_at: "2026-08-05 08:00:00.000000",
        ingested_at: "2026-08-01 13:00:00.000000000",
        version: 5,
        is_deleted: 1,
      },
    ]);
  });
});
