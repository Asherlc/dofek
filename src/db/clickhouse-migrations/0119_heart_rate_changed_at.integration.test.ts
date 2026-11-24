import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../clickhouse.ts";
import { createMigration as createMigration0060 } from "./0060_heart_rate_day_change.ts";
import { createMigration as createMigration0119 } from "./0119_heart_rate_changed_at.ts";

const changeSchema = z.array(
  z.object({
    changed_at: z.coerce.bigint(),
    recorded_date: z.string(),
  }),
);

describe("0119_heart_rate_changed_at migration", () => {
  const database = `hr_changed_at_${randomUUID().replaceAll("-", "")}`;
  const legacyUserId = randomUUID();
  let client: ClickHouseClient;
  let legacyMarker = 0n;

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
    for (const statement of createMigration0060().statements) {
      await client.command({ query: statement.replaceAll("analytics.", `${database}.`) });
    }

    await client.command({
      query: `INSERT INTO ${database}.deduped_sensor VALUES (
        {userId:UUID}, '2026-07-27 00:01:00', '2026-07-27', 'heart_rate', 60, 1, 0, '2026-07-27 01:00:00'
      )`,
      query_params: { userId: legacyUserId },
    });
    legacyMarker = await dayMarker(legacyUserId);

    for (const statement of createMigration0119().statements) {
      await client.command({ query: statement.replaceAll("analytics.", `${database}.`) });
    }
    for (const statement of createMigration0119().statements) {
      await client.command({ query: statement.replaceAll("analytics.", `${database}.`) });
    }
  });

  afterAll(async () => {
    await client?.command({ query: `DROP DATABASE IF EXISTS ${database}` });
  });

  async function dayMarker(userId: string): Promise<bigint> {
    const result = await client.query({
      query: `SELECT
        toString(recorded_date) AS recorded_date,
        toUnixTimestamp64Nano(max(changed_at)) AS changed_at
      FROM ${database}.heart_rate_day_change
      WHERE user_id = {userId:UUID}
      GROUP BY recorded_date`,
      query_params: { userId },
      format: "JSONEachRow",
    });
    const rows = changeSchema.parse(await result.json());
    expect(rows).toHaveLength(1);
    return rows[0]?.changed_at ?? 0n;
  }

  async function insertSensor(sqlValues: string, userId: string): Promise<void> {
    await client.command({
      query: `INSERT INTO ${database}.deduped_sensor (
        user_id, recorded_at, recorded_date, channel, scalar,
        refresh_version, is_deleted, refreshed_at, heart_rate_changed_at
      ) VALUES ${sqlValues}`,
      query_params: { userId },
    });
  }

  it("preserves a legacy day marker across upgrade reapplication", async () => {
    expect(await dayMarker(legacyUserId)).toBe(legacyMarker);
    const columns = z.array(z.object({ name: z.string() })).parse(
      await (
        await client.query({
          query: `SELECT name FROM system.columns
              WHERE database = {database:String} AND table = 'deduped_sensor'
              ORDER BY position`,
          query_params: { database },
          format: "JSONEachRow",
        })
      ).json(),
    );
    expect(columns.at(-1)?.name).toBe("heart_rate_changed_at");
  });

  it("excludes epoch-only and non-heart-rate inserts", async () => {
    const userId = randomUUID();
    await insertSensor(
      `(
        {userId:UUID}, '2026-07-31 00:01:00', '2026-07-31', 'steps', 100,
        1, 0, '2026-07-31 01:00:00', '2026-07-31 09:00:00'
      ),
      (
        {userId:UUID}, '2026-07-31 00:02:00', '2026-07-31', 'heart_rate', 55,
        1, 0, '2026-07-31 01:00:00', '1970-01-01 00:00:00'
      )`,
      userId,
    );
    const result = await client.query({
      query: `SELECT count() AS count
        FROM ${database}.heart_rate_day_change
        WHERE user_id = {userId:UUID}`,
      query_params: { userId },
      format: "JSONEachRow",
    });
    expect(z.array(z.object({ count: z.coerce.number() })).parse(await result.json())).toEqual([
      { count: 0 },
    ]);
  });

  it("advances on a newer stamp and stays stable on same-stamp replay", async () => {
    const userId = randomUUID();
    await insertSensor(
      `({userId:UUID}, '2026-07-29 00:01:00', '2026-07-29', 'heart_rate', 72,
        1, 0, '2026-07-29 01:00:00', '2026-07-29 03:00:00')`,
      userId,
    );
    const initial = await dayMarker(userId);

    await insertSensor(
      `({userId:UUID}, '2026-07-29 00:01:00', '2026-07-29', 'heart_rate', 72,
        2, 0, '2026-07-29 02:00:00', '2026-07-29 04:00:00')`,
      userId,
    );
    const afterAdvance = await dayMarker(userId);
    expect(afterAdvance).toBeGreaterThan(initial);

    await insertSensor(
      `({userId:UUID}, '2026-07-29 00:01:00', '2026-07-29', 'heart_rate', 72,
        3, 0, '2026-07-29 03:00:00', '2026-07-29 04:00:00')`,
      userId,
    );
    expect(await dayMarker(userId)).toBe(afterAdvance);
  });
});
