import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDbtBatch } from "./activity-payload-dbt-microbatch-test-helpers.ts";

describe("daily endurance load lifecycle", () => {
  const database = `endurance_load_${randomUUID().replaceAll("-", "")}`;
  const activityId = randomUUID();
  const userId = randomUUID();
  let client: ReturnType<typeof createClient>;
  let artifactDirectory: string;

  beforeAll(async () => {
    const url = process.env.CLICKHOUSE_URL;
    if (!url) throw new Error("CLICKHOUSE_URL is required");
    client = createClient({ url });
    artifactDirectory = await mkdtemp(join(tmpdir(), "endurance-load-dbt-"));
    await client.command({ query: `CREATE DATABASE ${database}` });
    for (const query of [
      `CREATE TABLE ${database}.activity_summary_rows (
        activity_id UUID, user_id UUID, canonical_type String,
        started_at DateTime64(6, 'UTC'), ended_at Nullable(DateTime64(6, 'UTC')),
        avg_hr Nullable(Float64), is_deleted UInt8, refresh_version UInt64,
        refreshed_at DateTime64(9, 'UTC')
      ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id)`,
      `CREATE TABLE ${database}.user_profile_current (
        id UUID, max_hr Nullable(Float64), resting_hr Nullable(Float64)
      ) ENGINE = MergeTree ORDER BY id`,
      `CREATE TABLE ${database}.resting_heart_rate_sleep_window (
        user_id UUID, ended_at Nullable(DateTime64(6, 'UTC')),
        resting_hr Nullable(Float64), is_deleted UInt8
      ) ENGINE = ReplacingMergeTree ORDER BY user_id`,
      `INSERT INTO ${database}.user_profile_current VALUES ('${userId}', 190, 60)`,
    ])
      await client.command({ query });
  });

  afterAll(async () => {
    await client?.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client?.close();
    if (artifactDirectory) await rm(artifactDirectory, { recursive: true, force: true });
  });

  it("removes stale load when an end time becomes unknown and restores it when supplied", async () => {
    for (const [version, endedAt, deleted] of [
      [1, "2024-01-30 00:49:27", 0],
      [2, null, 1],
      [3, "2024-01-30 00:49:27", 0],
    ] as const) {
      await client.insert({
        table: `${database}.activity_summary_rows`,
        format: "JSONEachRow",
        values: [
          {
            activity_id: activityId,
            user_id: userId,
            canonical_type: "cycling",
            started_at: "2024-01-29 23:49:27",
            ended_at: endedAt,
            avg_hr: 150,
            is_deleted: 0,
            refresh_version: version,
            refreshed_at: `2099-01-0${version} 00:00:00`,
          },
        ],
      });
      await runDbtBatch(
        database,
        artifactDirectory,
        ["daily_endurance_load"],
        "2024-01-29",
        "2024-01-31",
      );
      const result = await client.query({
        query: `SELECT is_deleted, training_load, ended_at FROM ${database}.daily_endurance_load FINAL`,
        format: "JSONEachRow",
      });
      const rows = await result.json<{
        is_deleted: number;
        training_load: number;
        ended_at: string | null;
      }>();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.is_deleted).toBe(deleted);
      if (endedAt === null) {
        expect(rows[0]?.training_load).toBe(0);
        expect(rows[0]?.ended_at).toBeNull();
      } else {
        expect(rows[0]?.training_load).toBeGreaterThan(0);
        expect(rows[0]?.training_load).toBeLessThan(100);
      }
    }
  }, 120_000);
});
