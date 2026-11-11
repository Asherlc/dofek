import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildIngestMetricStreamCreateTableSql } from "../../../../src/metric-stream/clickhouse-table.ts";
import type { ActivitySensorQueryStore } from "./activity-sensor-types.ts";
import {
  buildDailyHealthSensor,
  dailyHealthSensorModelSql,
  refreshDailyHealthSensor,
} from "./daily-health-sensor-test-helpers.ts";
import { fetchDailyMetricsWithSpo2Cte } from "./daily-metrics-spo2-query.ts";
import { WhoopSensorRepository } from "./whoop-sensor-repository.ts";

describe("daily health sensor model", () => {
  if (!process.env.CLICKHOUSE_URL) throw new Error("CLICKHOUSE_URL is required");
  const clickHouseUrl = new URL(process.env.CLICKHOUSE_URL);
  const client = createClient({ url: process.env.CLICKHOUSE_URL });
  const database = `health_sensor_${randomUUID().replaceAll("-", "")}`;
  const userId = randomUUID();
  const correctedId = randomUUID();
  const frameHex = readFileSync(
    new URL(
      "../../../mobile/modules/whoop-ble/Tests/fixtures/imu-activation-capture.tsv",
      import.meta.url,
    ),
    "utf8",
  )
    .split("\n")
    .map((line) => line.split("\t").at(-1) ?? "")
    .find((hex) => hex.length === 248 && hex.slice(16, 20) === "2f12");

  beforeAll(async () => {
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({
      query: buildIngestMetricStreamCreateTableSql().replaceAll("ingest.", `${database}.`),
    });
  });
  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await client.close();
  });

  async function insert(rows: object[]) {
    await client.insert({
      table: `${database}.metric_stream`,
      format: "JSONEachRow",
      values: rows.map((row) => ({
        id: randomUUID(),
        user_id: userId,
        provider_id: "apple_health",
        channel: "spo2",
        recorded_at: "2026-10-20 06:59:00",
        scalar: 0.97,
        version: 1,
        ...row,
      })),
    });
  }

  async function samples() {
    const result = await client.query({
      query: `SELECT samples.channel AS channel,
      samples.value AS value, toString(samples.measured_at) AS measured_at,
      samples.source_name AS source_name FROM ${database}.daily_health_sensor FINAL
      ARRAY JOIN samples WHERE user_id = {userId:UUID} ORDER BY channel, value`,
      query_params: { userId },
      format: "JSONEachRow",
    });
    return result.json<{
      channel: string;
      value: number;
      measured_at: string;
      source_name: string | null;
    }>();
  }

  it("decodes only valid health samples and keeps original measured time and device", async () => {
    expect(frameHex).toBeTruthy();
    await insert([
      { id: correctedId },
      {
        provider_id: "garmin",
        scalar: 98,
        recorded_at: "2026-10-20 07:00:00",
        activity_id: randomUUID(),
      },
      { scalar: 1.1 },
      { scalar: 0 },
      { scalar: null },
      {
        provider_id: "whoop_ble",
        channel: "sensor_record",
        scalar: null,
        device_id: "strap-a",
        metadata: JSON.stringify({ frameHex }),
        recorded_at: "2026-10-30 12:00:00",
      },
      {
        provider_id: "whoop_ble",
        channel: "sensor_record",
        scalar: null,
        metadata: JSON.stringify({ frameHex: "bad" }),
      },
      { channel: "heart_rate", scalar: 65 },
      { user_id: randomUUID(), scalar: 0.5 },
    ]);
    await refreshDailyHealthSensor(client, database);
    const rows = await samples();
    expect(rows).toHaveLength(3);
    expect(rows).toContainEqual({
      channel: "skin_temperature",
      value: 32.18,
      measured_at: "2026-03-29 15:28:11.430000",
      source_name: "strap-a",
    });
    expect(rows).toContainEqual({
      channel: "spo2",
      value: 98,
      measured_at: "2026-10-20 07:00:00.000000",
      source_name: null,
    });
    expect(rows.find((row) => row.channel === "spo2")?.value).toBeCloseTo(97, 4);
  });

  it("replaces corrected values and clears the final deleted sample on later builds", async () => {
    await insert([{ id: correctedId, scalar: 0.95, version: 2 }]);
    await refreshDailyHealthSensor(client, database);
    expect((await samples()).find((row) => row.channel === "spo2")?.value).toBeCloseTo(95, 4);
    await insert([{ id: correctedId, scalar: 0.95, version: 3, is_deleted: 1 }]);
    await refreshDailyHealthSensor(client, database);
    expect((await samples()).filter((row) => row.channel === "spo2")).toEqual([
      { channel: "spo2", value: 98, measured_at: "2026-10-20 07:00:00.000000", source_name: null },
    ]);
  });

  it("serves oxygen and delayed temperature daily values without access to the raw log", async () => {
    const fetchedRows: unknown[][] = [];
    const store: ActivitySensorQueryStore = {
      async query(schema, query, params) {
        const result = await client.query({
          query: query
            .replaceAll("ingest.", `${database}.`)
            .replaceAll("analytics.", `${database}.`),
          query_params: params,
          format: "JSONEachRow",
        });
        const rows = z.array(schema).parse(await result.json());
        fetchedRows.push(rows);
        return rows;
      },
    };
    await client.command({
      query: `RENAME TABLE ${database}.metric_stream TO ${database}.retained_raw_log`,
    });
    try {
      await fetchDailyMetricsWithSpo2Cte({
        sensorStore: store,
        userId,
        days: null,
        endDate: "2026-11-09",
        timezone: "America/Los_Angeles",
      });
      expect(fetchedRows[0]).toEqual(
        expect.arrayContaining([
          {
            date: "2026-10-20",
            provider_id: "garmin",
            source_name: null,
            spo2_avg: 98,
            skin_temp_c: null,
          },
          {
            date: "2026-03-29",
            provider_id: "whoop_ble",
            source_name: "strap-a",
            spo2_avg: null,
            skin_temp_c: 32.18,
          },
        ]),
      );
      expect(
        await new WhoopSensorRepository(store, userId).dailyTemperatures({
          days: 1,
          endDate: "2026-03-29",
          timezone: "Asia/Kathmandu",
        }),
      ).toEqual([
        {
          date: "2026-03-29",
          provider_id: "whoop_ble",
          source_name: "strap-a",
          skin_temp_c: 32.18,
        },
      ]);
    } finally {
      await client.command({
        query: `RENAME TABLE ${database}.retained_raw_log TO ${database}.metric_stream`,
      });
    }
  });

  it("uses native dbt initial/incremental builds and drains bounded dirty days without rewriting idle days", async () => {
    const target = `${database}.daily_health_sensor`;
    await client.command({ query: `DROP TABLE ${target}` });
    const runDbt = () =>
      promisify(execFile)(
        "uv",
        [
          "run",
          "--project",
          "analytics",
          "dbt",
          "run",
          "--project-dir",
          "analytics",
          "--profiles-dir",
          "analytics",
          "--target",
          "dev",
          "--target-path",
          `target/${database}`,
          "--select",
          "daily_health_sensor",
          "--vars",
          '{"health_sensor_day_batch_size":2}',
        ],
        {
          env: {
            ...process.env,
            UV_PROJECT_ENVIRONMENT: "../.venv-analytics",
            DBT_CLICKHOUSE_SCHEMA: database,
            DBT_CLICKHOUSE_HOST: clickHouseUrl.hostname,
            DBT_CLICKHOUSE_PORT: clickHouseUrl.port,
            DBT_CLICKHOUSE_USER: decodeURIComponent(clickHouseUrl.username),
            DBT_CLICKHOUSE_PASSWORD: decodeURIComponent(clickHouseUrl.password),
            DBT_ANALYTICS_SOURCE_SCHEMA: database,
            DBT_INGEST_SOURCE_SCHEMA: database,
            DBT_POSTGRES_FITNESS_SOURCE_SCHEMA: database,
          },
        },
      );
    const count = async () => {
      const result = await client.query({
        query: `SELECT count() AS count FROM ${target}`,
        format: "JSONEachRow",
      });
      return Number((await result.json<{ count: string }>())[0]?.count);
    };
    await runDbt();
    expect(await count()).toBe(2);
    await runDbt();
    expect(await count()).toBe(4);
    await buildDailyHealthSensor(client, database);
    expect(await count()).toBe(5);
    await buildDailyHealthSensor(client, database);
    expect(await count()).toBe(5);
    expect(await samples()).toHaveLength(2);
  }, 120_000);

  it("bounds raw reads to health sample keys when a user has large unrelated sensor history", async () => {
    await client.command({
      query: `INSERT INTO ${database}.metric_stream
      (id,activity_id,user_id,provider_id,recorded_at,channel,scalar)
      SELECT generateUUIDv4(),generateUUIDv4(),{user:UUID},'garmin',
        toDateTime64('2025-01-01',6) + toIntervalSecond(number % 86400),'heart_rate',70
      FROM numbers(100000)`,
      query_params: { user: userId },
    });
    await client.command({
      query: `INSERT INTO ${database}.metric_stream_day_change
      SELECT user_id,provider_id,toDate(recorded_at),now64(9)
      FROM ${database}.metric_stream GROUP BY user_id,provider_id,toDate(recorded_at)`,
    });
    const result = await client.query({
      query: `SELECT count() FROM (${dailyHealthSensorModelSql(database)})`,
      format: "JSON",
      clickhouse_settings: { join_use_nulls: 1, transform_null_in: 1, enable_materialized_cte: 1 },
    });
    const response = await result.json();
    expect(response.statistics?.rows_read).toBeLessThan(50000);
  });
});
