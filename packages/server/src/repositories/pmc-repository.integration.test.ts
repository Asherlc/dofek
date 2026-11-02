import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClickHouseClientFromEnv } from "../../../../src/db/clickhouse.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ChartRange } from "../lib/chart-range.ts";
import { ClickHouseActivitySensorStore } from "./clickhouse-activity-sensor-store.ts";
import { PmcRepository } from "./pmc-repository.ts";

describe("PmcRepository canonical activity stress", () => {
  const client = createClickHouseClientFromEnv();
  const database = `pmc_power_${randomUUID().replaceAll("-", "")}`;
  const userId = randomUUID();
  const activityIds = [randomUUID(), randomUUID()];
  const providerId = `pmc-${randomUUID()}`;
  const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const rewrite = (query: string) => query.replace(/\b(analytics|postgres_fitness)\b/g, database);
  let context: TestContext;
  let repository: PmcRepository;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name) VALUES (${userId}::uuid, 'Power-only PMC')`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id) VALUES (${providerId}, 'Power-only PMC', ${userId}::uuid)`,
    );
    for (const id of activityIds) {
      await context.db.execute(sql`INSERT INTO fitness.activity
        (id, group_id, user_id, provider_id, external_id, canonical_type, provider_type, started_at, ended_at)
        VALUES (${id}::uuid, ${id}::uuid, ${userId}::uuid, ${providerId}, ${id}, 'cycling', 'cycling',
          ${`${day}T10:00:00Z`}::timestamptz, ${`${day}T11:00:00Z`}::timestamptz)`);
    }
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({
      query: `CREATE TABLE ${database}.activity_summary
      (activity_id UUID, user_id UUID, started_at DateTime64(6, 'UTC'), ended_at DateTime64(6, 'UTC'),
      canonical_type String, avg_hr Nullable(Float64), max_hr Nullable(Float64), avg_power Nullable(Float64),
      power_sample_count UInt64, hr_sample_count UInt64) ENGINE=Memory`,
    });
    await client.command({
      query: `CREATE TABLE ${database}.user_profile_current
      (id UUID, max_hr Nullable(Float64), resting_hr Nullable(Float64)) ENGINE=Memory`,
    });
    await client.command({
      query: `CREATE TABLE ${database}.resting_heart_rate_sleep_window
      (user_id UUID, ended_at Nullable(DateTime64(6, 'UTC')), resting_hr Nullable(Float64),
      duration_seconds UInt32, is_deleted UInt8) ENGINE=ReplacingMergeTree ORDER BY user_id`,
    });
    await client.command({
      query: `CREATE TABLE ${database}.cycling_activity_power_metrics
      (user_id UUID, activity_id UUID, started_at DateTime64(6, 'UTC'), power_tss Nullable(Float64), eftp Nullable(Float64)) ENGINE=Memory`,
    });
    await client.command({
      query: `CREATE TABLE ${database}.cycling_threshold_history
      (user_id UUID, event_at DateTime64(6, 'UTC'), eftp Nullable(Float64)) ENGINE=Memory`,
    });
    await client.insert({
      table: `${database}.user_profile_current`,
      values: [{ id: userId, max_hr: null, resting_hr: null }],
      format: "JSONEachRow",
    });
    await client.insert({
      table: `${database}.activity_summary`,
      values: activityIds.map((id) => ({
        activity_id: id,
        user_id: userId,
        started_at: `${day} 10:00:00`,
        ended_at: `${day} 11:00:00`,
        canonical_type: "cycling",
        avg_hr: null,
        max_hr: null,
        avg_power: 150,
        power_sample_count: 3600,
        hr_sample_count: 0,
      })),
      format: "JSONEachRow",
    });
    await client.insert({
      table: `${database}.cycling_activity_power_metrics`,
      values: activityIds.map((id, index) => ({
        activity_id: id,
        user_id: userId,
        started_at: `${day} 10:00:00`,
        power_tss: index === 0 ? 80 : 125,
        eftp: index === 0 ? 200 : 250,
      })),
      format: "JSONEachRow",
    });
    await client.insert({
      table: `${database}.cycling_threshold_history`,
      values: [{ user_id: userId, event_at: `${day} 12:00:00`, eftp: 275 }],
      format: "JSONEachRow",
    });
    repository = new PmcRepository(
      context.db,
      userId,
      "UTC",
      new ClickHouseActivitySensorStore({
        command: (options) => client.command({ ...options, query: rewrite(options.query) }),
        query: (options) => client.query({ ...options, query: rewrite(options.query) }),
      }),
    );
  });

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close();
    await context?.cleanup();
  });

  it("uses each canonical ride's stress without HR and withholds unknown history", async () => {
    const result = await repository.getChart(ChartRange.fromDays(7));
    expect(result.model.ftp).toBe(275);
    expect(result.data.find((point) => point.date === day)?.load).toBe(205);
    expect(result.unavailableReason).toBeNull();
    await client.command({ query: `TRUNCATE TABLE ${database}.cycling_activity_power_metrics` });
    const missing = await repository.getChart(ChartRange.fromDays(7));
    expect(missing.data).toEqual([]);
    expect(missing.unavailableReason).toContain("2 cycling activities");
  });
});
