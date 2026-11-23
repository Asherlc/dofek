import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createClickHouseClientFromEnv } from "../../../../src/db/clickhouse.ts";
import { createMigration } from "../../../../src/db/clickhouse-migrations/0118_daily_sleep_wake_date_index.ts";
import { buildTestAnalyticsTableStatement } from "../routers/clickhouse-integration-test-models.ts";
import type { ActivitySensorQueryStore } from "./activity-sensor-types.ts";
import { fetchSleepNights } from "./clickhouse-sleep-repository.ts";

describe("fetchSleepNights with indexed wake dates", () => {
  const database = `overview_sleep_${randomUUID().replaceAll("-", "")}`;
  const userId = "00000000-0000-4000-8000-000000000001";
  const client = createClickHouseClientFromEnv();
  const window = { userId, timezone: "America/Los_Angeles", endDate: "2026-03-10", days: 20 };

  function sensorStore(requireWakeIndex = false): ActivitySensorQueryStore {
    return {
      async query<TSchema extends z.ZodType>(
        schema: TSchema,
        query: string,
        params?: Record<string, unknown>,
      ) {
        const result = await client.query({
          query: query.replaceAll("analytics.daily_sleep", `${database}.daily_sleep`),
          query_params: params,
          clickhouse_settings: {
            max_threads: 1,
            ...(requireWakeIndex ? { force_data_skipping_indices: "wake_utc_date_minmax" } : {}),
          },
          format: "JSONEachRow",
        });
        return z.array(schema).parse(await result.json<unknown>());
      },
    };
  }

  beforeAll(async () => {
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({
      query: buildTestAnalyticsTableStatement("analytics.daily_sleep").replaceAll(
        "analytics.",
        `${database}.`,
      ),
    });
    const insert = `INSERT INTO ${database}.daily_sleep
      (user_id, date, provider_id, source_name, local_time_source, started_at, ended_at,
        duration_minutes, refresh_version) VALUES`;
    await client.command({
      query: `${insert}
        ('${userId}', '2024-01-01', 'whoop', 'historical', 'unknown', '2024-01-02 05:00:00', '2024-01-02 13:00:00', NULL, 1)`,
    });
    await client.command({
      query: `${insert}
        ('${userId}', '2026-02-09', 'whoop', 'long', 'unknown', '2026-02-10 04:00:00', '2026-02-19 08:00:00', NULL, 1),
        ('${userId}', '2026-02-16', 'whoop', 'tokyo-start', 'unknown', '2026-02-17 05:00:00', '2026-02-18 17:00:00', NULL, 1),
        ('${userId}', '2026-02-17', 'whoop', 'before-start', 'unknown', '2026-02-18 05:00:00', '2026-02-19 07:59:00', NULL, 1),
        ('${userId}', '2026-02-18', 'whoop', 'superseded', 'unknown', '2026-02-19 04:00:00', '2026-02-19 10:00:00', NULL, 1),
        ('${userId}', '2026-03-09', 'whoop', 'duration-fallback', 'unknown', '2026-03-10 05:00:00', NULL, 1230, 1),
        ('${userId}', '2026-03-10', 'whoop', 'start-fallback', 'unknown', '2026-03-11 04:00:00', NULL, NULL, 1)`,
    });

    for (const statement of createMigration().statements) {
      await client.command({ query: statement.replaceAll("analytics.", `${database}.`) });
    }

    // Keep the revision in a separate part so FINAL must reconcile the index with it.
    await client.command({ query: `SYSTEM STOP MERGES ${database}.daily_sleep` });
    await client.command({
      query: `${insert}
        ('${userId}', '2026-02-18', 'whoop', 'latest', 'unknown', '2026-02-19 04:00:00', '2026-03-12 08:00:00', NULL, 2)`,
    });
  });

  afterAll(async () => {
    try {
      await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    } finally {
      await client.close?.();
    }
  });

  it("uses the wake-date index and keeps exact local dates and latest revisions", async () => {
    const rows = await fetchSleepNights({
      ...window,
      sensorStore: sensorStore(true),
      dateBasis: "wake",
    });

    expect(rows.map(({ source_name, date }) => [source_name, date])).toEqual([
      ["long", "2026-02-19"],
      ["duration-fallback", "2026-03-10"],
      ["start-fallback", "2026-03-10"],
    ]);
  });

  it("includes the first local day when its wake timestamp is on the previous UTC date", async () => {
    const rows = await fetchSleepNights({
      ...window,
      sensorStore: sensorStore(true),
      dateBasis: "wake",
      timezone: "Asia/Tokyo",
    });

    expect(rows.map(({ source_name, date }) => [source_name, date])).toContainEqual([
      "tokyo-start",
      "2026-02-19",
    ]);
  });

  it("caps all-history wake dates and preserves the default stored-night range", async () => {
    const historical = await fetchSleepNights({
      ...window,
      sensorStore: sensorStore(true),
      dateBasis: "wake",
      days: null,
    });
    const nights = await fetchSleepNights({ ...window, sensorStore: sensorStore() });

    expect(historical.map(({ date }) => date)).toEqual([
      "2024-01-02",
      "2026-02-19",
      "2026-02-18",
      "2026-02-18",
      "2026-03-10",
      "2026-03-10",
    ]);
    expect(nights.map(({ source_name, date }) => [source_name, date])).toEqual([
      ["latest", "2026-02-18"],
      ["duration-fallback", "2026-03-09"],
      ["start-fallback", "2026-03-10"],
    ]);
  });
});
