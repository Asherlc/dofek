import { randomBytes } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRefitSensorStore } from "../db/refit-sensor-store.ts";
import type { Database } from "../db/typed-sql.ts";
import { fitSleepFromDb, refitAllParams } from "./refit.ts";

const testUserId = "00000000-0000-4000-8000-000000001777";
type ClickHouseClient = ReturnType<typeof createClient>;

describe("personalization refit ClickHouse sleep inputs", () => {
  let client: ClickHouseClient | undefined;
  const targetSchema = `analytics_refit_test_${randomBytes(6).toString("hex")}`;

  beforeAll(async () => {
    client = createClient({
      url: requireClickHouseUrl(),
      request_timeout: 120_000,
    });
    await assertClickHouseReady(client);
  }, 120_000);

  afterAll(async () => {
    if (client) {
      await client.command({ query: `DROP DATABASE IF EXISTS ${targetSchema} SYNC` });
      await client.close();
    }
  });

  it("fits from live daily sleep rows while excluding a tombstoned row", async () => {
    const activeClient = requireClient(client);
    const sleepDates = Array.from({ length: 15 }, (_, index) => utcDateDaysAgo(30 + index));
    const tombstonedDate = utcDateDaysAgo(46);
    await seedFixture(activeClient, targetSchema, sleepDates, tombstonedDate);

    let executedQuery: string | undefined;
    const sensorStore = createRefitSensorStore({
      query: async (args) => {
        executedQuery = args.query;
        return activeClient.query({
          query: args.query.replaceAll("analytics.daily_sleep", `${targetSchema}.daily_sleep`),
          format: args.format,
          query_params: args.query_params,
        });
      },
    });
    const db = {
      execute: async () =>
        [...sleepDates, tombstonedDate].map((date) => ({
          date: addDays(date, 1),
          hrv_above_median: true,
        })),
    } satisfies Database;

    await expect(fitSleepFromDb(db, sensorStore, testUserId)).resolves.toEqual({
      minutes: 480,
      sampleCount: 15,
    });
    expect(executedQuery).toContain("analytics.daily_sleep AS sleep FINAL");
    expect(executedQuery).toContain("sleep.is_deleted = 0");
    expect(executedQuery).toContain("sleep.date >= toDate(now() - INTERVAL 365 DAY)");
    expect(executedQuery).not.toContain("analytics.v_sleep");
  }, 180_000);

  it("fits readiness through the public refit flow with tombstoned sleep excluded", async () => {
    const activeClient = requireClient(client);
    const sleepDates = Array.from({ length: 15 }, (_, index) => utcDateDaysAgo(30 + index));
    const tombstonedDate = utcDateDaysAgo(46);
    const metricDates = Array.from({ length: 60 }, (_, index) => utcDateDaysAgo(30 + index));
    await seedFixture(activeClient, targetSchema, sleepDates, tombstonedDate);

    const dailySleepRows: unknown[][] = [];
    const dailySleepQueries: string[] = [];
    const sensorStore = createRefitSensorStore({
      query: async (args) => {
        if (!args.query.includes("analytics.daily_sleep")) {
          return { json: async () => [] };
        }
        dailySleepQueries.push(args.query);

        const result = await activeClient.query({
          query: args.query.replaceAll("analytics.daily_sleep", `${targetSchema}.daily_sleep`),
          format: args.format,
          query_params: args.query_params,
        });
        return {
          json: async () => {
            const rows = await result.json();
            dailySleepRows.push(rows);
            return rows;
          },
        };
      },
    });
    const readinessRows = createReadinessRows(metricDates);
    const db = {
      execute: async () => readinessRows,
    } satisfies Database;

    const result = await refitAllParams(db, testUserId, sensorStore);

    expect(result.readinessWeights).toMatchObject({ sampleCount: metricDates.length });
    expect(dailySleepRows).toHaveLength(2);
    expect(dailySleepQueries).toEqual(
      expect.arrayContaining([
        expect.stringContaining("sleep.date >= toDate(now() - INTERVAL 425 DAY)"),
        expect.stringContaining("sleep.date >= toDate(now() - INTERVAL 365 DAY)"),
      ]),
    );
    expect(dailySleepRows.flat()).toContainEqual(expect.objectContaining({ date: sleepDates[0] }));
    expect(dailySleepRows.flat()).not.toContainEqual(
      expect.objectContaining({ date: tombstonedDate }),
    );
  }, 180_000);
});

function requireClickHouseUrl(): string {
  const url = process.env.CLICKHOUSE_URL?.trim();
  if (!url) {
    throw new Error("CLICKHOUSE_URL is required for personalization refit integration tests");
  }
  return url;
}

function requireClient(client: ClickHouseClient | undefined): ClickHouseClient {
  if (!client) {
    throw new Error("ClickHouse client was not initialized");
  }
  return client;
}

async function assertClickHouseReady(client: ClickHouseClient): Promise<void> {
  const result = await client.query({ query: "SELECT 1", format: "JSONEachRow" });
  await result.json();
}

function utcDateDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function seedFixture(
  client: ClickHouseClient,
  targetSchema: string,
  sleepDates: string[],
  tombstonedDate: string,
): Promise<void> {
  await client.command({ query: `DROP DATABASE IF EXISTS ${targetSchema} SYNC` });
  await client.command({ query: `CREATE DATABASE ${targetSchema}` });
  await client.command({
    query: `CREATE TABLE ${targetSchema}.daily_sleep (
      user_id UUID,
      date Date,
      started_at DateTime64(6, 'UTC'),
      duration_minutes Nullable(Int32),
      efficiency_pct Nullable(Float32),
      is_deleted UInt8,
      refresh_version UInt64
    ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, date)`,
  });
  const liveRows = sleepDates.map(
    (date, index) =>
      `('${testUserId}', toDate('${date}'), toDateTime64('${date} 08:00:00', 6, 'UTC'), 480, 85, 0, ${index + 1})`,
  );
  liveRows.push(
    `('${testUserId}', toDate('${tombstonedDate}'), toDateTime64('${tombstonedDate} 08:00:00', 6, 'UTC'), 480, 95, 0, 99)`,
    `('${testUserId}', toDate('${tombstonedDate}'), toDateTime64('${tombstonedDate} 08:00:00', 6, 'UTC'), 60, 100, 1, 100)`,
  );
  await client.command({
    query: `INSERT INTO ${targetSchema}.daily_sleep VALUES ${liveRows.join(",\n")}`,
  });
}

function createReadinessRows(dates: string[]): Record<string, unknown>[] {
  return dates.map((date, index) => {
    const hrv = 40 + index;
    return {
      date,
      hrv,
      resting_hr: 55,
      hrv_mean: 70,
      hrv_sd: 20,
      rhr_mean: 55,
      rhr_sd: 5,
      respiratory_rate: 16,
      rr_mean: 16,
      rr_sd: 1,
      efficiency_pct: null,
      next_day_hrv: hrv,
      next_day_hrv_mean: 70,
      next_day_hrv_sd: 20,
    };
  });
}
