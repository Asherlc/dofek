// cspell:ignore rollups
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "./schema.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
}, 120_000);

afterAll(async () => {
  await ctx?.cleanup();
});

async function refreshActivityViews(): Promise<void> {
  await ctx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.v_activity`);
  await ctx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.deduped_sensor`);
  await ctx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.activity_summary`);
}

async function createProvider(providerId: string): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO fitness.provider (id, name, user_id)
    VALUES (${providerId}, ${providerId}, ${TEST_USER_ID})
    ON CONFLICT (id) DO NOTHING
  `);
}

async function createActivity(providerId: string, startedAt: string, endedAt: string) {
  const activityRows = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO fitness.activity (
      provider_id, user_id, activity_type, started_at, ended_at, name
    )
    VALUES (
      ${providerId},
      ${TEST_USER_ID},
      'cycling',
      ${startedAt},
      ${endedAt},
      'Rollup Ride'
    )
    RETURNING id
  `);
  const activityId = activityRows[0]?.id;
  if (!activityId) {
    throw new Error("Expected activity insert to return an id");
  }
  return activityId;
}

describe("analytics activity rollups", () => {
  it("refreshes one activity summary from canonical views and deduped sensor data", async () => {
    const providerId = "rollup-provider";
    await createProvider(providerId);
    const activityId = await createActivity(
      providerId,
      "2026-04-20T10:00:00Z",
      "2026-04-20T10:05:00Z",
    );

    await ctx.db.execute(sql`
      INSERT INTO fitness.metric_stream (
        recorded_at, user_id, provider_id, device_id, source_type, channel, activity_id, scalar
      )
      VALUES
        ('2026-04-20T10:00:00Z', ${TEST_USER_ID}, ${providerId}, 'dev-1', 'api', 'heart_rate', ${activityId}::uuid, 120),
        ('2026-04-20T10:01:00Z', ${TEST_USER_ID}, ${providerId}, 'dev-1', 'api', 'heart_rate', ${activityId}::uuid, 130),
        ('2026-04-20T10:02:00Z', ${TEST_USER_ID}, ${providerId}, 'dev-1', 'api', 'heart_rate', ${activityId}::uuid, 140),
        ('2026-04-20T10:00:00Z', ${TEST_USER_ID}, ${providerId}, 'dev-1', 'api', 'power', ${activityId}::uuid, 180),
        ('2026-04-20T10:01:00Z', ${TEST_USER_ID}, ${providerId}, 'dev-1', 'api', 'power', ${activityId}::uuid, 200),
        ('2026-04-20T10:02:00Z', ${TEST_USER_ID}, ${providerId}, 'dev-1', 'api', 'power', ${activityId}::uuid, 220)
    `);

    await refreshActivityViews();
    await ctx.db.execute(
      sql`SELECT analytics.refresh_activity_training_summary(${activityId}::uuid)`,
    );

    const rows = await ctx.db.execute<{
      avg_hr: number;
      avg_power: number;
      hr_sample_count: string;
      power_sample_count: string;
      hr_bpm_counts: Record<string, number>;
      power_watt_counts: Record<string, number>;
    }>(sql`
      SELECT avg_hr, avg_power, hr_sample_count, power_sample_count,
             hr_bpm_counts, power_watt_counts
      FROM analytics.activity_training_summary
      WHERE activity_id = ${activityId}::uuid
    `);

    expect(rows[0]).toMatchObject({
      avg_hr: 130,
      avg_power: 200,
      hr_sample_count: "3",
      power_sample_count: "3",
    });
    expect(rows[0]?.hr_bpm_counts).toEqual({ "120": 1, "130": 1, "140": 1 });
    expect(rows[0]?.power_watt_counts).toEqual({ "180": 1, "200": 1, "220": 1 });
  });

  it("marks linked activities dirty when metric stream rows are inserted", async () => {
    const providerId = "dirty-provider";
    await createProvider(providerId);
    const activityId = await createActivity(
      providerId,
      "2026-04-21T10:00:00Z",
      "2026-04-21T11:00:00Z",
    );

    await ctx.db.execute(sql`
      INSERT INTO fitness.metric_stream (
        recorded_at, user_id, provider_id, device_id, source_type, channel, activity_id, scalar
      )
      VALUES (
        '2026-04-21T10:00:00Z',
        ${TEST_USER_ID},
        ${providerId},
        'dev-1',
        'api',
        'heart_rate',
        ${activityId}::uuid,
        123
      )
    `);

    const rows = await ctx.db.execute<{ activity_id: string; reason: string }>(sql`
      SELECT activity_id::text, reason
      FROM analytics.activity_rollup_dirty
      WHERE activity_id = ${activityId}::uuid
    `);

    expect(rows).toEqual([{ activity_id: activityId, reason: "metric_stream_changed" }]);
  });
});
