import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import type { ActivityHardware } from "@dofek/providers/activity-hardware";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { buildIngestMetricStreamCreateTableSql } from "../../../../src/metric-stream/clickhouse-table.ts";
import { normalizeActivityHardware } from "../models/activity-hardware.ts";
import { getActivityMetricSources } from "./activity-metric-sources-repository.ts";

describe("activity hardware source labels in ClickHouse", () => {
  const database = `hardware_labels_${randomUUID().replaceAll("-", "")}`;
  const userId = randomUUID(),
    member = randomUUID(),
    peripheral = randomUUID();
  const window = {
    userId,
    activityId: member,
    memberActivityIds: [member],
    startedAt: "2026-10-20T12:00:00.000Z",
    endedAt: "2026-10-20T13:00:00.000Z",
  };
  let client: ReturnType<typeof createClient>;
  const scope = (query: string) =>
    query.replaceAll("analytics.", `${database}.`).replaceAll("ingest.", `${database}.`);
  const store = {
    async query<T extends z.ZodType>(
      schema: T,
      query: string,
      params?: Record<string, unknown>,
    ): Promise<z.infer<T>[]> {
      const result = await client.query({
        query: scope(query),
        query_params: params,
        format: "JSONEachRow",
      });
      return (await result.json<unknown>()).map((row) => schema.parse(row));
    },
  };
  beforeAll(async () => {
    if (!process.env.CLICKHOUSE_URL) throw new Error("CLICKHOUSE_URL is required");
    client = createClient({ url: process.env.CLICKHOUSE_URL });
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({ query: scope(buildIngestMetricStreamCreateTableSql()) });
    await client.command({
      query: `CREATE TABLE ${database}.sensor_scalar_sample (
      id UUID, activity_id Nullable(UUID), user_id UUID, recorded_at DateTime64(6, 'UTC'), recorded_date Date,
      channel String, provider_id String, device_id Nullable(String), scalar Float32, provider_priority Int32,
      _peerdb_is_deleted Int8, _peerdb_version Int64
    ) ENGINE = ReplacingMergeTree(_peerdb_version) ORDER BY (user_id,channel,recorded_date,recorded_at,provider_id,id)`,
    });
    await client.insert({
      table: `${database}.sensor_scalar_sample`,
      format: "JSONEachRow",
      values: [
        {
          id: randomUUID(),
          activity_id: null,
          user_id: userId,
          recorded_at: "2026-10-20 12:00:00",
          recorded_date: "2026-10-20",
          channel: "heart_rate",
          provider_id: "ble_heart_rate",
          device_id: peripheral,
          scalar: 140,
          provider_priority: 1,
        },
        {
          id: randomUUID(),
          activity_id: member,
          user_id: userId,
          recorded_at: "2026-10-20 12:00:00",
          recorded_date: "2026-10-20",
          channel: "heart_rate",
          provider_id: "strava",
          device_id: null,
          scalar: 150,
          provider_priority: 2,
        },
        {
          id: randomUUID(),
          activity_id: member,
          user_id: userId,
          recorded_at: "2026-10-20 12:00:00",
          recorded_date: "2026-10-20",
          channel: "power",
          provider_id: "strava",
          device_id: null,
          scalar: 0,
          provider_priority: 2,
        },
      ],
    });
    const raw = {
      user_id: userId,
      provider_id: "ble_heart_rate",
      device_id: peripheral,
      channel: "heart_rate",
      scalar: 140,
      recorded_at: "2026-10-20 12:00:00",
      metadata: JSON.stringify({ device_name: "Polar H10" }),
    };
    await client.insert({
      table: `${database}.metric_stream`,
      format: "JSONEachRow",
      values: [
        { ...raw, id: randomUUID() },
        {
          ...raw,
          id: randomUUID(),
          recorded_at: "2026-10-20 12:00:01",
          metadata: JSON.stringify({ device_name: "Polar H10 updated" }),
        },
        {
          ...raw,
          id: randomUUID(),
          user_id: randomUUID(),
          recorded_at: "2026-10-20 12:00:50",
          metadata: JSON.stringify({ device_name: "Foreign user" }),
        },
        {
          ...raw,
          id: randomUUID(),
          activity_id: randomUUID(),
          recorded_at: "2026-10-20 12:00:51",
          metadata: JSON.stringify({ device_name: "Other activity" }),
        },
        {
          ...raw,
          id: randomUUID(),
          recorded_at: "2026-10-20 14:00:00",
          metadata: JSON.stringify({ device_name: "Outside window" }),
        },
        {
          ...raw,
          id: randomUUID(),
          recorded_at: "2026-10-20 12:00:52",
          is_deleted: 1,
          metadata: JSON.stringify({ device_name: "Deleted" }),
        },
        {
          ...raw,
          id: randomUUID(),
          recorded_at: "2026-10-20 12:00:53",
          channel: "temperature",
          metadata: JSON.stringify({ device_name: "Other channel" }),
        },
      ],
    });
  });
  afterAll(async () => {
    await client?.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client?.close();
  });
  it("uses only owned, visible, eligible BLE metadata and preserves source selection and scalar samples", async () => {
    const result = await getActivityMetricSources(store, window);
    const sourceId = JSON.stringify(["ble_heart_rate", peripheral]);
    expect(result[0]).toMatchObject({
      defaultSourceId: sourceId,
      sources: [
        { id: sourceId, label: "Heart Rate Monitor (Bluetooth) · Polar H10 updated" },
        { id: "strava", label: "Strava" },
      ],
    });
    const hardware: ActivityHardware = {
      items: [
        {
          id: "recorder",
          activityId: member,
          providerId: "strava",
          sourceName: null,
          role: "recorder",
          label: "Edge 530",
          model: null,
          manufacturer: null,
          evidence: "Reported",
          details: [],
        },
      ],
      power: [],
    };
    const enriched = await getActivityMetricSources(store, window, hardware);
    expect(enriched[0]?.sources[1]?.label).toBe("Strava · recorded by Edge 530");
    expect(
      enriched.map((metric) => [
        metric.key,
        metric.defaultSourceId,
        metric.sources.map((source) => source.id),
      ]),
    ).toEqual(
      result.map((metric) => [
        metric.key,
        metric.defaultSourceId,
        metric.sources.map((source) => source.id),
      ]),
    );
    const samples = await client.query({
      query: `SELECT scalar FROM ${database}.sensor_scalar_sample FINAL ORDER BY scalar`,
      format: "JSONEachRow",
    });
    expect(await samples.json()).toEqual([{ scalar: 0 }, { scalar: 140 }, { scalar: 150 }]);
  });
  it("qualifies FIT creators and preserves separate provider recorders without changing source selection or power", async () => {
    const fitMember = randomUUID(),
      garminMember = randomUUID();
    const scopedWindow = {
      ...window,
      memberActivityIds: [fitMember, garminMember],
      startedAt: "2026-10-20T14:00:00.000Z",
      endedAt: "2026-10-20T15:00:00.000Z",
    };
    const rows = [
      { member: fitMember, provider: "fit-file", scalar: 0, priority: 1 },
      { member: garminMember, provider: "garmin", scalar: 125, priority: 2 },
    ];
    await client.insert({
      table: `${database}.sensor_scalar_sample`,
      format: "JSONEachRow",
      values: rows.map((row) => ({
        id: randomUUID(),
        activity_id: row.member,
        user_id: userId,
        recorded_at: "2026-10-20 14:00:00",
        recorded_date: "2026-10-20",
        channel: "power",
        provider_id: row.provider,
        device_id: null,
        scalar: row.scalar,
        provider_priority: row.priority,
      })),
    });
    const hardware = normalizeActivityHardware(
      rows.map((row) => ({
        activityId: row.member,
        providerId: row.provider,
        sourceName: null,
        raw: row.provider === "garmin" ? { deviceName: "Edge 530" } : null,
        observations: [
          { sequence: 0, messageType: "file_id", raw: { product_name: "Export platform" } },
        ],
      })),
    );
    const before = await getActivityMetricSources(store, scopedWindow);
    const after = await getActivityMetricSources(store, scopedWindow, hardware);
    expect(after[0]?.sources).toEqual([
      { id: "fit-file", label: "FIT File · file created by Export platform" },
      { id: "garmin", label: "Garmin · recorded by Edge 530" },
    ]);
    expect(
      after.map((metric) => [
        metric.key,
        metric.defaultSourceId,
        metric.sources.map((source) => source.id),
      ]),
    ).toEqual(
      before.map((metric) => [
        metric.key,
        metric.defaultSourceId,
        metric.sources.map((source) => source.id),
      ]),
    );
    const samples = await client.query({
      query: `SELECT scalar FROM ${database}.sensor_scalar_sample FINAL WHERE recorded_at='2026-10-20 14:00:00' ORDER BY scalar`,
      format: "JSONEachRow",
    });
    expect(await samples.json()).toEqual([{ scalar: 0 }, { scalar: 125 }]);
  });
});
