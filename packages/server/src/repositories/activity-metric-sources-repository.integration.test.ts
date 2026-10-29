import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildIncrementalDedupedSensorBaseTableStatements,
  buildSensorScalarSampleBackfillSql,
} from "../../../../src/db/clickhouse-deduped-sensor.ts";
import { buildPostgresFitnessRawTableStatements } from "../../../../src/db/clickhouse-raw-tables.ts";
import { buildIngestMetricStreamCreateTableSql } from "../../../../src/metric-stream/clickhouse-table.ts";
import {
  buildTestAnalyticsTableStatement,
  rewriteClickHouseDatabaseNames,
} from "../routers/clickhouse-integration-test-models.ts";
import {
  getActivityMetricSources,
  getActivityPowerWork,
  getActivitySourceHrZones,
} from "./activity-metric-sources-repository.ts";
import { ClickHouseActivitySensorStore } from "./clickhouse-activity-sensor-store.ts";

const userId = "00000000-0000-0000-0000-000000000001";
const activityId = randomUUID();
const window = {
  activityId,
  userId,
  startedAt: "2026-10-20T12:00:00.000Z",
  endedAt: "2026-10-20T13:00:00.000Z",
  memberActivityIds: [activityId],
};

describe("activity metric source selection", () => {
  const database = `metric_sources_${randomUUID().replaceAll("-", "")}`;
  const scope = (query: string) =>
    rewriteClickHouseDatabaseNames(query, {
      analytics: database,
      ingest: database,
      postgresFitness: database,
    });
  let client: ReturnType<typeof createClient>;
  let store: ClickHouseActivitySensorStore;
  async function executeCommand(query: string) {
    await client.command({ query: scope(query) });
  }
  async function insertMetricStreamRows(
    rows: readonly {
      userId: string;
      providerId: string;
      deviceId: string;
      sourceType: string;
      channel: string;
      scalar: number;
      recordedAt: string;
    }[],
  ) {
    await client.insert({
      table: `${database}.metric_stream`,
      format: "JSONEachRow",
      values: rows.map((row) => ({
        id: randomUUID(),
        user_id: row.userId,
        provider_id: row.providerId,
        device_id: row.deviceId,
        source_type: row.sourceType,
        channel: row.channel,
        scalar: row.scalar,
        recorded_at: row.recordedAt.replace("T", " ").replace("Z", ""),
        metadata: "",
      })),
    });
  }
  beforeAll(async () => {
    if (!process.env.CLICKHOUSE_URL) throw new Error("CLICKHOUSE_URL is required");
    client = createClient({ url: process.env.CLICKHOUSE_URL });
    await executeCommand(`CREATE DATABASE ${database}`);
    const rawSchemas = buildPostgresFitnessRawTableStatements().filter((query) =>
      [
        "CREATE TABLE IF NOT EXISTS postgres_fitness.sensor_provider_priority (",
        "CREATE TABLE IF NOT EXISTS postgres_fitness.sensor_device_priority (",
        "CREATE TABLE IF NOT EXISTS postgres_fitness.user_profile (",
        "CREATE VIEW IF NOT EXISTS postgres_fitness.user_profile_current AS",
      ].some((prefix) => query.startsWith(prefix)),
    );
    const scalarSchemas = buildIncrementalDedupedSensorBaseTableStatements().filter((query) =>
      query.startsWith("CREATE TABLE IF NOT EXISTS analytics.sensor_scalar_sample ("),
    );
    for (const query of [
      buildIngestMetricStreamCreateTableSql(),
      ...scalarSchemas,
      ...rawSchemas,
      buildTestAnalyticsTableStatement("analytics.activity_stream_points"),
      buildTestAnalyticsTableStatement("analytics.activity_sensor_sample"),
      buildTestAnalyticsTableStatement("analytics.resting_heart_rate_sleep_window"),
    ]) {
      await executeCommand(query);
    }
    await executeCommand(`INSERT INTO postgres_fitness.user_profile (id, max_hr, resting_hr)
      VALUES ('${userId}', 200, 60)`);
    store = new ClickHouseActivitySensorStore({
      query: (options) => client.query({ ...options, query: scope(options.query) }),
      command: (options) => client.command({ ...options, query: scope(options.query) }),
    });
    await executeCommand(
      `INSERT INTO analytics.sensor_scalar_sample
      (id, activity_id, user_id, recorded_at, recorded_date, channel, provider_id, scalar, provider_priority, _peerdb_is_deleted, _peerdb_version)
      VALUES
      (generateUUIDv4(), '${activityId}', '${userId}', '2026-10-20 12:00:00', '2026-10-20', 'power', 'garmin', 0, 1, 0, 1),
      (generateUUIDv4(), '${activityId}', '${userId}', '2026-10-20 12:00:00', '2026-10-20', 'power', 'wahoo', 250, 2, 0, 1),
      (generateUUIDv4(), '${activityId}', '${userId}', '2026-10-20 12:00:00', '2026-10-20', 'speed', 'garmin', 0, 1, 0, 1),
      (generateUUIDv4(), '${activityId}', '${userId}', '2026-10-20 12:00:00', '2026-10-20', 'speed', 'whoop', 3, 2, 0, 1),
      (generateUUIDv4(), '${activityId}', '${userId}', '2026-10-20 12:00:00', '2026-10-20', 'cadence', 'garmin', 0, 1, 0, 1),
      (generateUUIDv4(), '${activityId}', '${userId}', '2026-10-20 12:00:00', '2026-10-20', 'cadence', 'whoop', 85, 2, 0, 1),
      (generateUUIDv4(), '${activityId}', '${userId}', '2026-10-20 12:00:00', '2026-10-20', 'altitude', 'garmin', -10, 1, 0, 1),
      (generateUUIDv4(), '${activityId}', '${userId}', '2026-10-20 12:00:00', '2026-10-20', 'altitude', 'whoop', 35, 2, 0, 1),
      (generateUUIDv4(), '${activityId}', '${userId}', '2026-10-20 12:00:00', '2026-10-20', 'heart_rate', 'garmin', 100, 2, 0, 1),
      (generateUUIDv4(), NULL, '${userId}', '2026-10-20 12:00:00', '2026-10-20', 'heart_rate', 'whoop', 150, 1, 0, 1),
      (generateUUIDv4(), NULL, '${userId}', '2026-10-20 12:00:01', '2026-10-20', 'heart_rate', 'whoop', 180, 1, 0, 1),
      (generateUUIDv4(), '${randomUUID()}', '${userId}', '2026-10-20 12:00:00', '2026-10-20', 'heart_rate', 'unrelated', 190, 0, 0, 1),
      (generateUUIDv4(), NULL, '${randomUUID()}', '2026-10-20 12:00:00', '2026-10-20', 'heart_rate', 'other_user', 190, 0, 0, 1),
      (generateUUIDv4(), NULL, '${userId}', '2026-10-20 11:59:59', '2026-10-20', 'heart_rate', 'outside_window', 190, 0, 0, 1),
      (generateUUIDv4(), NULL, '${userId}', '2026-10-20 12:00:00', '2026-10-20', 'heart_rate', 'deleted', 190, 0, 1, 1),
      (generateUUIDv4(), NULL, '${userId}', '2026-10-20 12:00:00', '2026-10-20', 'temperature', 'temperature_only', 190, 0, 0, 1)`,
    );
    await executeCommand(
      `INSERT INTO analytics.activity_stream_points
      (user_id, activity_id, points, refresh_version, is_deleted, refreshed_at) VALUES
      ('${userId}', '${activityId}',
       [(toDateTime64('2026-10-20 12:00:00', 6, 'UTC'), 150, 200, NULL, NULL, NULL, NULL, NULL)],
       1, 0, now64(9))`,
    );
  });
  afterAll(async () => {
    await client?.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client?.close();
  });

  it("prefers activity-linked HR over standalone recordings and keeps other metric priorities", async () => {
    const metrics = await getActivityMetricSources(store, window);
    expect(metrics.map((metric) => [metric.key, metric.defaultSourceId])).toEqual([
      ["heartRate", "garmin"],
      ["power", "garmin"],
      ["speed", "garmin"],
      ["cadence", "garmin"],
      ["altitude", "garmin"],
    ]);
    expect(
      metrics.find((metric) => metric.key === "heartRate")?.sources.map((source) => source.id),
    ).toEqual(["garmin", "whoop"]);
    expect(
      metrics.find((metric) => metric.key === "power")?.sources.map((source) => source.id),
    ).toEqual(["garmin", "wahoo"]);
  });
  it("ranks unlinked HR by distinct valid timestamps, then provider priority", async () => {
    const densityWindow = {
      ...window,
      startedAt: "2026-10-21T12:00:00.000Z",
      endedAt: "2026-10-21T13:00:00.000Z",
    };
    await executeCommand(`INSERT INTO analytics.sensor_scalar_sample
      (id, user_id, recorded_at, recorded_date, channel, provider_id, device_id, scalar, provider_priority)
      VALUES
      (generateUUIDv4(), '${userId}', '2026-10-21 12:00:00', '2026-10-21', 'heart_rate', 'apple_health', 'Watch', 100, 1),
      (generateUUIDv4(), '${userId}', '2026-10-21 12:00:00', '2026-10-21', 'heart_rate', 'apple_health', 'Watch', 101, 1),
      (generateUUIDv4(), '${userId}', '2026-10-21 12:00:01', '2026-10-21', 'heart_rate', 'apple_health', 'Watch', 0, 1),
      (generateUUIDv4(), '${userId}', '2026-10-21 12:00:02', '2026-10-21', 'heart_rate', 'apple_health', 'Watch', -1, 1),
      (generateUUIDv4(), '${userId}', '2026-10-21 12:00:00', '2026-10-21', 'heart_rate', 'whoop_ble', 'strap', 150, 2),
      (generateUUIDv4(), '${userId}', '2026-10-21 12:00:01', '2026-10-21', 'heart_rate', 'whoop_ble', 'strap', 151, 2),
      (generateUUIDv4(), '${userId}', '2026-10-21 12:00:00', '2026-10-21', 'heart_rate', 'polar', 'strap', 160, 3),
      (generateUUIDv4(), '${userId}', '2026-10-21 12:00:01', '2026-10-21', 'heart_rate', 'polar', 'strap', 161, 3)`);
    const metrics = await getActivityMetricSources(store, densityWindow);
    expect(metrics[0]?.defaultSourceId).toBe('["whoop_ble","strap"]');
    expect(metrics[0]?.sources.map((source) => source.id)).toEqual([
      '["whoop_ble","strap"]',
      '["polar","strap"]',
      '["apple_health","Watch"]',
    ]);

    const hardware = {
      items: [
        {
          id: "watch-recorder",
          activityId,
          providerId: "apple_health",
          sourceName: "Watch",
          role: "recorder" as const,
          label: "Apple Watch",
          model: null,
          manufacturer: null,
          evidence: "Recording device reported by HealthKit",
          details: [],
        },
      ],
      power: [],
    };
    const recorded = await getActivityMetricSources(store, densityWindow, hardware);
    expect(recorded[0]?.defaultSourceId).toBe('["apple_health","Watch"]');
    const exported = await getActivityMetricSources(store, densityWindow, {
      ...hardware,
      items: hardware.items.map((item) => ({ ...item, role: "creator" as const })),
    });
    expect(exported[0]?.defaultSourceId).toBe('["whoop_ble","strap"]');
  });
  it("replaces HR with the requested source without mixing in default HR or losing power", async () => {
    const points = await store.getStream(window, 500, { heartRate: "garmin" });
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ heart_rate: 100, power: 200 });
    const whoop = await store.getStream(window, 500, { heartRate: "whoop" });
    expect(whoop.map((point) => point.heart_rate)).toEqual([150, 180]);
    expect(whoop[0]?.power).toBe(200);
  });
  it("selects every metric independently and retains zero readings and negative elevation", async () => {
    const points = await store.getStream(window, 500, {
      heartRate: "garmin",
      power: "wahoo",
      speed: "garmin",
      cadence: "garmin",
      altitude: "garmin",
    });
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({
      heart_rate: 100,
      power: 250,
      speed: 0,
      cadence: 0,
      altitude: -10,
    });
  });
  it("uses the selected power source for zones and does not invent samples for an empty source", async () => {
    const zeroPower = await store.getPowerZoneSeconds(window, 200, "garmin");
    expect(zeroPower.find((zone) => zone.zone === 1)?.seconds).toBe(1);
    const wahoo = await store.getPowerZoneSeconds(window, 200, "wahoo");
    expect(wahoo.find((zone) => zone.zone === 6)?.seconds).toBe(1);
    expect(wahoo.find((zone) => zone.zone === 1)?.seconds).toBe(0);
    const missing = await store.getPowerZoneSeconds(window, 200, "not-a-source");
    expect(missing.every((zone) => zone.seconds === 0)).toBe(true);
  });
  it("integrates the selected device's full power stream without crossing users, activities, or time windows", async () => {
    const rideId = randomUUID();
    const powerWindow = {
      ...window,
      activityId: rideId,
      memberActivityIds: [rideId],
      startedAt: "2026-10-20T19:00:00.000Z",
      endedAt: "2026-10-20T19:00:12.000Z",
    };
    await executeCommand(`INSERT INTO analytics.sensor_scalar_sample
      (id, activity_id, user_id, recorded_at, recorded_date, channel, provider_id, device_id, scalar, provider_priority, _peerdb_is_deleted, _peerdb_version)
      VALUES
      (generateUUIDv4(), '${rideId}', '${userId}', '2026-10-20 19:00:00', '2026-10-20', 'power', 'wahoo', 'pedals', 200, 1, 0, 1),
      (generateUUIDv4(), '${rideId}', '${userId}', '2026-10-20 19:00:00', '2026-10-20', 'power', 'wahoo', 'pedals', 3000, 2, 0, 1),
      (generateUUIDv4(), '${rideId}', '${userId}', '2026-10-20 19:00:01', '2026-10-20', 'power', 'wahoo', 'pedals', 0, 1, 0, 1),
      (generateUUIDv4(), NULL, '${userId}', '2026-10-20 19:00:02', '2026-10-20', 'power', 'wahoo', 'pedals', 300, 1, 0, 1),
      (generateUUIDv4(), '${rideId}', '${userId}', '2026-10-20 19:00:10', '2026-10-20', 'power', 'wahoo', 'pedals', 100, 1, 0, 1),
      (generateUUIDv4(), '${rideId}', '${userId}', '2026-10-20 19:00:11', '2026-10-20', 'power', 'wahoo', 'pedals', 100, 1, 0, 1),
      (generateUUIDv4(), '${randomUUID()}', '${userId}', '2026-10-20 19:00:00', '2026-10-20', 'power', 'wahoo', 'pedals', 5000, 0, 0, 1),
      (generateUUIDv4(), '${rideId}', '${randomUUID()}', '2026-10-20 19:00:00', '2026-10-20', 'power', 'wahoo', 'pedals', 5000, 0, 0, 1),
      (generateUUIDv4(), '${rideId}', '${userId}', '2026-10-20 18:59:59', '2026-10-20', 'power', 'wahoo', 'pedals', 5000, 0, 0, 1),
      (generateUUIDv4(), '${rideId}', '${userId}', '2026-10-20 19:00:13', '2026-10-20', 'power', 'wahoo', 'pedals', 5000, 0, 0, 1),
      (generateUUIDv4(), '${rideId}', '${userId}', '2026-10-20 19:00:03', '2026-10-20', 'power', 'wahoo', 'pedals', 5000, 0, 1, 1)`);
    await executeCommand(`INSERT INTO analytics.sensor_scalar_sample
      (id, activity_id, user_id, recorded_at, recorded_date, channel, provider_id, device_id, scalar, provider_priority, _peerdb_is_deleted, _peerdb_version)
      SELECT generateUUIDv4(), toUUID('${rideId}'), toUUID('${userId}'),
        toDateTime64('2026-10-20 19:00:00', 6, 'UTC') + toIntervalSecond(number),
        toDate('2026-10-20'), 'power', 'wahoo', 'trainer', 0, 0, 0, 1
      FROM numbers(12)`);

    expect(await getActivityPowerWork(store, powerWindow, '["wahoo","pedals"]')).toEqual({
      workKilojoules: 0.7,
      coverage: { coveredSeconds: 5, coveragePct: 41.7 },
    });
    expect(await getActivityPowerWork(store, powerWindow, '["wahoo","trainer"]')).toEqual({
      workKilojoules: 0,
      coverage: { coveredSeconds: 12, coveragePct: 100 },
    });
    expect(await getActivityPowerWork(store, powerWindow, "missing")).toEqual({
      workKilojoules: null,
      coverage: { coveredSeconds: 0, coveragePct: 0 },
    });
  });

  it("uses canonical full-resolution power when no source is selected", async () => {
    const rideId = randomUUID();
    const powerWindow = {
      ...window,
      activityId: rideId,
      memberActivityIds: [rideId],
      startedAt: "2026-10-20T20:00:00.000Z",
      endedAt: "2026-10-20T20:00:12.000Z",
    };
    await executeCommand(`INSERT INTO analytics.activity_sensor_sample
      (activity_id, user_id, recorded_at, channel, scalar, refresh_version, is_deleted)
      SELECT toUUID('${rideId}'), toUUID('${userId}'),
        toDateTime64('2026-10-20 20:00:00', 6, 'UTC') + toIntervalSecond(number),
        'power', 250, 1, 0 FROM numbers(12)`);
    expect(await getActivityPowerWork(store, powerWindow)).toEqual({
      workKilojoules: 3,
      coverage: { coveredSeconds: 12, coveragePct: 100 },
    });
  });
  it("calculates zones from the selected provider, excluding other providers", async () => {
    const zones = await getActivitySourceHrZones(store, window, "garmin");
    expect(zones.find((zone) => zone.zone === 0)).toMatchObject({ seconds: 1, percent: 100 });
    expect(zones.reduce((sum, zone) => sum + zone.seconds, 0)).toBe(1);
  });
  it("does not expose another user's sources or samples", async () => {
    const otherWindow = { ...window, userId: randomUUID() };
    expect(await getActivityMetricSources(store, otherWindow)).toEqual([]);
    expect(await store.getStream(otherWindow, 500, { heartRate: "whoop" })).toEqual([]);
  });

  it("selects distinct Apple Health devices using the opaque source IDs returned by SQL", async () => {
    const deviceActivityId = randomUUID();
    const deviceWindow = {
      activityId: deviceActivityId,
      userId,
      startedAt: "2026-10-20T14:00:00.000Z",
      endedAt: "2026-10-20T14:01:00.000Z",
      memberActivityIds: [deviceActivityId],
    };
    await executeCommand(
      `INSERT INTO analytics.sensor_scalar_sample
      (id, activity_id, user_id, recorded_at, recorded_date, channel, provider_id, device_id, scalar, provider_priority, _peerdb_is_deleted, _peerdb_version)
      VALUES
      (generateUUIDv4(), '${deviceActivityId}', '${userId}', '2026-10-20 14:00:00', '2026-10-20', 'heart_rate', 'apple_health', 'Zepp', 130, 1, 0, 1),
      (generateUUIDv4(), '${deviceActivityId}', '${userId}', '2026-10-20 14:00:00', '2026-10-20', 'heart_rate', 'apple_health', 'Apple Watch / Series 8', 155, 2, 0, 1)`,
    );
    const metrics = await getActivityMetricSources(store, deviceWindow);
    expect(metrics).toHaveLength(1);
    const heartRate = metrics[0];
    expect(heartRate?.key).toBe("heartRate");
    expect(heartRate?.sources).toHaveLength(2);
    const zepp = heartRate?.sources.find((source) => source.label.includes("Zepp"));
    const watch = heartRate?.sources.find((source) =>
      source.label.includes("Apple Watch / Series 8"),
    );
    expect(zepp).toBeDefined();
    expect(watch).toBeDefined();
    if (!zepp || !watch) throw new Error("Expected both Apple Health device sources");
    expect(zepp.id).not.toBe(watch.id);
    expect(heartRate?.defaultSourceId).toBe(zepp.id);
    const points = await store.getStream(deviceWindow, 500, { heartRate: watch.id });
    expect(points.map((point) => point.heart_rate)).toEqual([155]);
    const zones = await getActivitySourceHrZones(store, deviceWindow, watch.id);
    expect(zones.find((zone) => zone.zone === 2)?.seconds).toBe(1);
    expect(zones.reduce((sum, zone) => sum + zone.seconds, 0)).toBe(1);
  });

  it("caps a selected raw power stream while retaining zero and the first and last readings", async () => {
    const powerActivityId = randomUUID();
    const powerWindow = {
      activityId: powerActivityId,
      userId,
      startedAt: "2026-10-20T15:00:00.000Z",
      endedAt: "2026-10-20T15:01:00.000Z",
      memberActivityIds: [powerActivityId],
    };
    await executeCommand(
      `INSERT INTO analytics.sensor_scalar_sample
      (id, activity_id, user_id, recorded_at, recorded_date, channel, provider_id, scalar, provider_priority, _peerdb_is_deleted, _peerdb_version)
      SELECT generateUUIDv4(), toUUID('${powerActivityId}'), toUUID('${userId}'),
        toDateTime64('2026-10-20 15:00:00', 6, 'UTC') + toIntervalSecond(number),
        toDate('2026-10-20'), 'power', 'garmin', toFloat64(number), 1, 0, 1
      FROM numbers(30)`,
    );
    const points = await store.getStream(powerWindow, 10, { power: "garmin" });
    expect(points).toHaveLength(10);
    expect(points[0]?.power).toBe(0);
    expect(points.at(-1)?.power).toBe(29);
  });

  it("offers retained WHOOP Bluetooth intervals as a selectable heart-rate stream with recording gaps", async () => {
    const intervalWindow = {
      ...window,
      startedAt: "2026-10-20T16:00:00.000Z",
      endedAt: "2026-10-20T16:02:00.000Z",
    };
    await insertMetricStreamRows([
      {
        userId,
        providerId: "whoop_ble",
        deviceId: "strap-a",
        sourceType: "ble",
        channel: "rr_interval_ms",
        scalar: 750,
        recordedAt: "2026-10-20T16:00:00.000Z",
      },
      {
        userId,
        providerId: "whoop_ble",
        deviceId: "strap-a",
        sourceType: "ble",
        channel: "rr_interval_ms",
        scalar: 500,
        recordedAt: "2026-10-20T16:01:00.000Z",
      },
    ]);
    await executeCommand(buildSensorScalarSampleBackfillSql());
    const metrics = await getActivityMetricSources(store, intervalWindow);
    const heartRate = metrics.find((metric) => metric.key === "heartRate");
    expect(heartRate?.sources).toEqual([
      {
        id: '["whoop_ble","strap-a"]',
        label: expect.stringContaining("WHOOP"),
        presentation: {
          displayName: "WHOOP",
          providerId: "whoop_ble",
          sourceName: "strap-a",
          attribution: { kind: "bluetooth", label: "Bluetooth" },
        },
      },
    ]);
    if (!heartRate) throw new Error("Expected a derived heart-rate source");
    const points = await store.getStream(intervalWindow, 500, {
      heartRate: heartRate.defaultSourceId,
    });
    expect(points.map((point) => [point.recorded_at, point.heart_rate])).toEqual([
      ["2026-10-20T16:00:00.000Z", 80],
      ["2026-10-20T16:01:00.000Z", 120],
    ]);
    const zones = await getActivitySourceHrZones(store, intervalWindow, heartRate.defaultSourceId);
    expect(zones.find((zone) => zone.zone === 0)?.seconds).toBe(2);
  });

  it("prefers reported BPM to estimated BPM from the same device in selected charts and zones", async () => {
    const overlapWindow = {
      ...window,
      startedAt: "2026-10-20T17:00:00.000Z",
      endedAt: "2026-10-20T17:01:00.000Z",
    };
    await executeCommand(
      `INSERT INTO analytics.sensor_scalar_sample
      (id, user_id, recorded_at, recorded_date, channel, provider_id, device_id, scalar,
       measurement_kind, provider_priority, _peerdb_is_deleted, _peerdb_version) VALUES
      ('00000000-0000-0000-0000-000000000001', '${userId}', '2026-10-20 17:00:00', '2026-10-20', 'heart_rate', 'whoop_ble', 'strap-b', 180, 'estimated', 1, 0, 1),
      ('00000000-0000-0000-0000-000000000099', '${userId}', '2026-10-20 17:00:00', '2026-10-20', 'heart_rate', 'whoop_ble', 'strap-b', 150, 'unknown', 1, 0, 1)`,
    );
    const sourceId = '["whoop_ble","strap-b"]';
    const points = await store.getStream(overlapWindow, 500, { heartRate: sourceId });
    expect(points.map((point) => point.heart_rate)).toEqual([150]);
    const zones = await getActivitySourceHrZones(store, overlapWindow, sourceId);
    expect(zones.find((zone) => zone.zone === 2)?.seconds).toBe(1);
    expect(zones.find((zone) => zone.zone === 4)?.seconds).toBe(0);
  });

  it("serves reported WHOOP Bluetooth heart rate through a gap in beat intervals", async () => {
    const heartRateWindow = {
      ...window,
      startedAt: "2026-10-20T18:00:00.000Z",
      endedAt: "2026-10-20T18:00:03.000Z",
    };
    await insertMetricStreamRows([
      ...[
        { recordedAt: "2026-10-20T18:00:00.000Z", scalar: 128 },
        { recordedAt: "2026-10-20T18:00:01.000Z", scalar: 130 },
        { recordedAt: "2026-10-20T18:00:02.000Z", scalar: 132 },
      ].map((sample) => ({
        ...sample,
        userId,
        providerId: "whoop_ble",
        deviceId: "strap-c",
        sourceType: "ble",
        channel: "heart_rate",
      })),
      ...[
        { recordedAt: "2026-10-20T18:00:00.000Z", scalar: 750 },
        { recordedAt: "2026-10-20T18:00:02.000Z", scalar: 500 },
      ].map((sample) => ({
        ...sample,
        userId,
        providerId: "whoop_ble",
        deviceId: "strap-c",
        sourceType: "ble",
        channel: "rr_interval_ms",
      })),
    ]);
    await executeCommand(buildSensorScalarSampleBackfillSql());

    const metrics = await getActivityMetricSources(store, heartRateWindow);
    const heartRate = metrics.find((metric) => metric.key === "heartRate");
    expect(heartRate?.defaultSourceId).toBe('["whoop_ble","strap-c"]');
    if (!heartRate) throw new Error("Expected reported WHOOP Bluetooth heart rate");

    const points = await store.getStream(heartRateWindow, 500, {
      heartRate: heartRate.defaultSourceId,
    });
    expect(points.map((point) => [point.recorded_at, point.heart_rate])).toEqual([
      ["2026-10-20T18:00:00.000Z", 128],
      ["2026-10-20T18:00:01.000Z", 130],
      ["2026-10-20T18:00:02.000Z", 132],
    ]);
    const zones = await getActivitySourceHrZones(store, heartRateWindow, heartRate.defaultSourceId);
    expect(zones.reduce((total, zone) => total + zone.seconds, 0)).toBe(3);
  });
});
