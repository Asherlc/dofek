import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../clickhouse.ts";
import { createMigration } from "./0060_heart_rate_day_change.ts";

const changeSchema = z.array(
  z.object({
    changed_at: z.coerce.bigint(),
    recorded_date: z.string(),
  }),
);

describe("0060_heart_rate_day_change migration", () => {
  const database = `heart_rate_day_change_${randomUUID().replaceAll("-", "")}`;
  let client: ClickHouseClient;

  beforeAll(async () => {
    client = createClickHouseClientFromEnv();
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({
      query: `CREATE TABLE ${database}.deduped_sensor (
        user_id UUID,
        recorded_at DateTime64(6, 'UTC'),
        recorded_date Date,
        channel LowCardinality(String),
        scalar Nullable(Float32),
        refresh_version UInt64,
        is_deleted UInt8,
        refreshed_at DateTime64(9, 'UTC')
      )
      ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, channel, recorded_date, recorded_at)`,
    });

    for (const statement of createMigration().statements) {
      await client.command({ query: statement.replaceAll("analytics.", `${database}.`) });
    }
  });

  afterAll(async () => {
    await client?.command({ query: `DROP DATABASE IF EXISTS ${database}` });
  });

  it("advances the day maximum for heart-rate tombstones and ignores other channels", async () => {
    const userId = randomUUID();

    await client.command({
      query: `INSERT INTO ${database}.deduped_sensor VALUES
        (
          {userId:UUID},
          '2026-07-27 00:01:00',
          '2026-07-27',
          'heart_rate',
          60,
          1,
          0,
          '2026-07-27 01:00:00'
        ),
        (
          {userId:UUID},
          '2026-07-28 00:02:00',
          '2026-07-28',
          'steps',
          1,
          1,
          0,
          '2026-07-27 02:00:00'
        )`,
      query_params: { userId },
    });

    const initialResult = await client.query({
      query: `SELECT
        toString(recorded_date) AS recorded_date,
        toUnixTimestamp64Nano(max(changed_at)) AS changed_at
      FROM ${database}.heart_rate_day_change
      WHERE user_id = {userId:UUID}
      GROUP BY recorded_date`,
      query_params: { userId },
      format: "JSONEachRow",
    });
    const initialRows = changeSchema.parse(await initialResult.json());
    expect(initialRows).toHaveLength(1);
    expect(initialRows[0]?.recorded_date).toBe("2026-07-27");

    await client.command({
      query: `INSERT INTO ${database}.deduped_sensor VALUES (
        {userId:UUID},
        '2026-07-27 00:01:00',
        '2026-07-27',
        'heart_rate',
        NULL,
        2,
        1,
        '2020-01-01 00:00:00'
      )`,
      query_params: { userId },
    });

    const tombstoneResult = await client.query({
      query: `SELECT
        toString(recorded_date) AS recorded_date,
        toUnixTimestamp64Nano(max(changed_at)) AS changed_at
      FROM ${database}.heart_rate_day_change
      WHERE user_id = {userId:UUID}
      GROUP BY recorded_date`,
      query_params: { userId },
      format: "JSONEachRow",
    });
    const tombstoneRows = changeSchema.parse(await tombstoneResult.json());
    expect(tombstoneRows).toHaveLength(1);
    expect(tombstoneRows[0]?.changed_at).toBeGreaterThan(initialRows[0]?.changed_at ?? 0n);
  });
});
