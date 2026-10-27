import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../clickhouse.ts";
import { createMigration } from "./0086_activity_location_member_change.ts";

const freshnessRowsSchema = z.array(
  z.object({
    changed_at: z.string(),
    has_live_sample: z.coerce.number().int(),
    member_activity_id: z.string(),
  }),
);

describe("0086_activity_location_member_change migration", () => {
  const database = `activity_location_member_change_${randomUUID().replaceAll("-", "")}`;
  const userId = randomUUID();
  const historicalMemberId = randomUUID();
  const deletedOnlyMemberId = randomUUID();
  let client: ClickHouseClient;

  beforeAll(async () => {
    client = createClickHouseClientFromEnv();
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({
      query: `CREATE TABLE ${database}.metric_stream (
        id UUID,
        activity_id Nullable(UUID),
        user_id UUID,
        channel String,
        point Nullable(String),
        ingested_at DateTime64(9, 'UTC'),
        is_deleted UInt8
      ) ENGINE = MergeTree ORDER BY (user_id, activity_id, channel, id)
        SETTINGS allow_nullable_key = 1`,
    });
    await client.command({
      query: `INSERT INTO ${database}.metric_stream VALUES
        (generateUUIDv4(), {historicalMemberId:UUID}, {userId:UUID}, 'location',
         '(-122.3,37.8)', toDateTime64('2026-09-01 10:00:00', 9, 'UTC'), 0),
        (generateUUIDv4(), {historicalMemberId:UUID}, {userId:UUID}, 'heart_rate',
         NULL, toDateTime64('2026-09-01 11:00:00', 9, 'UTC'), 0)`,
      query_params: { historicalMemberId, userId },
    });

    for (const statement of createMigration().statements) {
      const scopedStatement = statement
        .replaceAll("analytics.", `${database}.`)
        .replaceAll("ingest.metric_stream", `${database}.metric_stream`);
      await client.command({ query: scopedStatement });
    }
  });

  afterAll(async () => {
    await client?.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await client?.close?.();
  });

  async function readFreshness(): Promise<z.infer<typeof freshnessRowsSchema>> {
    const result = await client.query({
      query: `SELECT
        toString(member_activity_id) AS member_activity_id,
        toString(max(changed_at)) AS changed_at,
        max(has_live_sample) AS has_live_sample
      FROM ${database}.activity_location_member_change
      WHERE user_id = {userId:UUID}
      GROUP BY member_activity_id
      ORDER BY member_activity_id`,
      query_params: { userId },
      format: "JSONEachRow",
    });
    return freshnessRowsSchema.parse(await result.json());
  }

  it("backfills existing location members and tracks later inserts", async () => {
    expect(await readFreshness()).toEqual([
      {
        changed_at: "2026-09-01 10:00:00.000000000",
        has_live_sample: 1,
        member_activity_id: historicalMemberId,
      },
    ]);

    await client.command({
      query: `INSERT INTO ${database}.metric_stream VALUES
        (generateUUIDv4(), {historicalMemberId:UUID}, {userId:UUID}, 'location',
         NULL, toDateTime64('2026-09-02 10:00:00', 9, 'UTC'), 1),
        (generateUUIDv4(), {deletedOnlyMemberId:UUID}, {userId:UUID}, 'location',
         NULL, toDateTime64('2026-09-03 10:00:00', 9, 'UTC'), 1)`,
      query_params: { deletedOnlyMemberId, historicalMemberId, userId },
    });

    const updatedFreshness = await readFreshness();
    expect(updatedFreshness).toHaveLength(2);
    expect(updatedFreshness).toEqual(
      expect.arrayContaining([
        {
          changed_at: "2026-09-03 10:00:00.000000000",
          has_live_sample: 0,
          member_activity_id: deletedOnlyMemberId,
        },
        {
          changed_at: "2026-09-02 10:00:00.000000000",
          has_live_sample: 1,
          member_activity_id: historicalMemberId,
        },
      ]),
    );
  });
});
