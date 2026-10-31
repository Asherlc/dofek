import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildIngestMetricStreamCreateTableSql } from "../../../../src/metric-stream/clickhouse-table.ts";
import { rewriteClickHouseDatabaseNames } from "../routers/clickhouse-integration-test-models.ts";
import { ClickHouseActivitySensorStore } from "./clickhouse-activity-sensor-store.ts";
import { WhoopSensorRepository } from "./whoop-sensor-repository.ts";

const userId = "00000000-0000-4000-8000-000000000001";
const otherUserId = "00000000-0000-4000-8000-000000000002";
const frameHex =
  readFileSync(
    new URL(
      "../../../mobile/modules/whoop-ble/Tests/fixtures/imu-activation-capture.tsv",
      import.meta.url,
    ),
    "utf8",
  )
    .split("\n")
    .map((line) => line.split("\t").at(-1) ?? "")
    .find((hex) => hex.length === 248 && hex.slice(16, 20) === "2f12") ?? "";

describe("WHOOP retained sensor records", () => {
  const database = `whoop_sensors_${randomUUID().replaceAll("-", "")}`;
  const scope = (query: string) =>
    rewriteClickHouseDatabaseNames(query, {
      analytics: database,
      ingest: database,
      postgresFitness: database,
    });
  let client: ReturnType<typeof createClient>;
  let repository: WhoopSensorRepository;

  beforeAll(async () => {
    if (!process.env.CLICKHOUSE_URL) throw new Error("CLICKHOUSE_URL is required");
    client = createClient({ url: process.env.CLICKHOUSE_URL });
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({ query: scope(buildIngestMetricStreamCreateTableSql()) });
    const store = new ClickHouseActivitySensorStore({
      query: (options) => client.query({ ...options, query: scope(options.query) }),
      command: (options) => client.command({ ...options, query: scope(options.query) }),
    });
    repository = new WhoopSensorRepository(store, userId);
    await client.insert({
      table: `${database}.metric_stream`,
      format: "JSONEachRow",
      values: [
        { user_id: userId, device_id: "strap-a", is_deleted: 0 },
        { user_id: otherUserId, device_id: "other-strap", is_deleted: 0 },
        { user_id: userId, device_id: "deleted-strap", is_deleted: 1 },
      ].map((row) => ({
        ...row,
        id: randomUUID(),
        provider_id: "whoop_ble",
        source_type: "ble",
        channel: "sensor_record",
        recorded_at: "2026-10-30 12:00:00.000",
        metadata: JSON.stringify({
          captureId: randomUUID(),
          timestamp: "2026-10-30T12:00:00.000Z",
          frameHex,
          deviceInfo: { name: "WHOOP", firmware: "50.42.1.0" },
        }),
      })),
    });
  });

  afterAll(async () => {
    if (client) {
      await client.command({ query: `DROP DATABASE IF EXISTS ${database}` });
      await client.close();
    }
  });

  it("serves only the owner's retained records and original device provenance", async () => {
    const snapshot = await repository.snapshot();
    expect(snapshot.skinTemperatureC).toBe(32.18);
    expect(snapshot.latestMeasuredAt).toBe("2026-03-29T15:28:11.430Z");
    expect(snapshot.latestReceivedAt).toBe("2026-10-30T12:00:00.000Z");
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.records[0]).toMatchObject({
      deviceId: "strap-a",
      rawFrameHex: frameHex,
      deviceInfo: { firmware: "50.42.1.0" },
    });
  });

  it("assigns delayed offloads to the source measurement day, with replay duplicates counted once", async () => {
    const otherFrame = readFileSync(
      new URL(
        "../../../mobile/modules/whoop-ble/Tests/fixtures/imu-activation-capture.tsv",
        import.meta.url,
      ),
      "utf8",
    )
      .split("\n")
      .map((line) => line.split("\t").at(-1) ?? "")
      .find(
        (hex) =>
          hex.length === 248 && hex.slice(16, 20) === "2f12" && hex.slice(146, 150) === "900c",
      );
    if (!otherFrame) throw new Error("Missing captured 32.16 degree thermal fixture");
    await client.insert({
      table: `${database}.metric_stream`,
      format: "JSONEachRow",
      values: [frameHex, otherFrame].map((hex) => ({
        id: randomUUID(),
        user_id: userId,
        provider_id: "whoop_ble",
        device_id: "strap-a",
        source_type: "ble",
        channel: "sensor_record",
        recorded_at: "2026-10-30 12:00:01.000",
        metadata: JSON.stringify({
          captureId: randomUUID(),
          timestamp: "2026-10-30T12:00:01.000Z",
          frameHex: hex,
          deviceInfo: {},
        }),
      })),
    });
    expect(
      await repository.dailyTemperatures({ days: 1, endDate: "2026-03-29", timezone: "UTC" }),
    ).toEqual([
      { date: "2026-03-29", provider_id: "whoop_ble", source_name: "strap-a", skin_temp_c: 32.17 },
    ]);
    expect(
      await repository.dailyTemperatures({ days: 1, endDate: "2026-10-30", timezone: "UTC" }),
    ).toEqual([]);
  });
});
